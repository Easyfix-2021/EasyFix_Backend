const router = require('express').Router();
const multer = require('multer');
const ExcelJS = require('exceljs');

const { parseBuffer } = require('../../utils/excel-parser');
const { bulkUpload } = require('../../services/job-upload.service');
const { modernOk, modernError } = require('../../utils/response');

// In-memory storage: upload parsed immediately, buffer discarded on request end.
// 10 MB limit matches the legacy SPRING_SERVLET_MULTIPART_MAX_FILE_SIZE.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    // Filename extension is the clear user-intent signal — accept .xlsx / .xls.
    if (!/\.xlsx?$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('only .xlsx / .xls files accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

/*
 * GET /api/admin/jobs/upload-template
 *
 * Returns the canonical 10-column "Unconfirmed Bulk Upload" template
 * with Excel-level data validations:
 *   - Customer Mobile Number → whole-number, 10 digits (rejects text)
 *   - Type of Service        → list dropdown sourced from a hidden
 *                              vocabulary sheet (Installation / Repair
 *                              / UnInstallation)
 *   - Mode of Payment        → list dropdown sourced from a hidden
 *                              vocabulary sheet (Free for customer /
 *                              Paid by Customer)
 *
 * Excel validations are applied to a wide range of rows (2..1000) so
 * clients can paste large batches without re-applying the rules.
 *
 * We use `exceljs` (not the `xlsx` library) because the SheetJS
 * community build can't reliably write dataValidation rules. The
 * parser still uses xlsx on the read side — it doesn't need to honor
 * validations, just read the cell values.
 */
router.get('/upload-template', async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'EasyFix';
    wb.created = new Date();

    // ─── Main sheet (preserve legacy name "buldJobFormatSheet") ────
    const ws = wb.addWorksheet('buldJobFormatSheet');
    const headers = [
      'Client Reference ID',
      'Customer Name',
      'Customer Mobile Number',
      'Service Delivery Address',
      'Date of Appointment (dd-mm-yyyy)',
      'Product Quantity',
      'Mode of Payment (Free for customer / Paid by customer)',
      'Type of Service (Installation / Repair / UnInstallation)',
      'Job Description',
      'Special Comments',
    ];
    ws.addRow(headers);
    // Header-only template per ops spec (2026-05-19) — no example
    // row. Operators want a clean canvas; instructions live in the
    // column headers + the data-validation tooltips below.

    // Header row styling — bold + light fill so the example row stands out.
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' },
    };
    ws.columns = headers.map((h) => ({
      width: Math.max(14, Math.min(40, h.length + 4)),
    }));

    // ─── Hidden vocabulary sheets ──────────────────────────────────
    // The list-validation references below resolve against these.
    // `state = 'veryHidden'` keeps the sheet out of the unhide menu;
    // operators can't accidentally edit the vocab and break the dropdowns.
    const modeSheet = wb.addWorksheet('hidden', { state: 'veryHidden' });
    modeSheet.addRow(['Free for customer']);
    modeSheet.addRow(['Paid by Customer']);
    const typeSheet = wb.addWorksheet('hidden1', { state: 'veryHidden' });
    typeSheet.addRow(['Installation']);
    typeSheet.addRow(['Repair']);
    typeSheet.addRow(['UnInstallation']);

    // ─── Data validations — apply to rows 2..1000 ──────────────────
    // Mobile (col C) — whole number with exactly 10 digits. The
    // `[1000000000, 9999999999]` range enforces the 10-digit length
    // (Excel doesn't have a "string length" rule for numeric cells).
    for (let r = 2; r <= 1000; r++) {
      ws.getCell(`C${r}`).dataValidation = {
        type: 'whole',
        operator: 'between',
        showErrorMessage: true,
        allowBlank: false,
        formulae: [1000000000, 9999999999],
        errorStyle: 'error',
        errorTitle: 'Invalid mobile',
        error: 'Customer Mobile must be a 10-digit number.',
      };

      // Mode of Payment (col G) — list from `hidden`!$A$1:$A$2
      ws.getCell(`G${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['=hidden!$A$1:$A$2'],
        showErrorMessage: true,
        errorStyle: 'error',
        errorTitle: 'Invalid value',
        error: 'Pick one: Free for customer / Paid by Customer.',
      };

      // Type of Service (col H) — list from `hidden1`!$A$1:$A$3.
      // Multi-select: operators can type a CSV like "Installation,
      // Repair". Excel's list validation is single-pick by design, so
      // we downgrade `errorStyle` to 'information' — the dropdown
      // still appears for single-pick convenience and Excel only
      // *informs* (doesn't block) when the cell contains a CSV. The
      // BE parser does the strict whitelist check against each token.
      ws.getCell(`H${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['=hidden1!$A$1:$A$3'],
        showErrorMessage: true,
        errorStyle: 'information',
        errorTitle: 'Multi-select allowed',
        error: 'Pick one, or type multiple values comma-separated, e.g. "Installation, Repair".',
      };
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="easyfix-unconfirmed-jobs-upload-template.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

/*
 * POST /api/admin/jobs/upload?dryRun=true
 *
 * multipart/form-data:
 *   file:     .xlsx (10-column format — see GET /upload-template)
 *   clientId: numeric — the client every row in the batch will be created against
 *
 * Every created row lands in UNCONFIRMED (job_status=9). Operators
 * complete the rest of the details (city, pin, service type, owner,
 * time slot) via the per-row Confirm & Schedule flow before booking.
 */
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'missing "file" upload');
    const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';
    const clientId = Number(req.body.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return modernError(res, 400, 'clientId is required — pick a client on the upload form');
    }

    let parsed;
    try {
      parsed = parseBuffer(req.file.buffer);
    } catch (parseErr) {
      return modernError(res, 400, `could not parse xlsx: ${parseErr.message}`);
    }
    if (parsed.totalRows === 0) {
      return modernError(res, 400, 'xlsx has no data rows (expecting header in row 1, data from row 2)');
    }
    const report = await bulkUpload(parsed, req.user, { dryRun, clientId });

    modernOk(res, report, dryRun ? 'validation complete (no rows inserted)' : 'bulk upload complete');
  } catch (e) {
    if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

module.exports = router;
