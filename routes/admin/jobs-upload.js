const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');

const { parseBuffer } = require('../../utils/excel-parser');
const { bulkUpload } = require('../../services/job-upload.service');
const { modernOk, modernError } = require('../../utils/response');

// In-memory storage: upload parsed immediately, buffer discarded on request end.
// Limit 10 MB (matches legacy SPRING_SERVLET_MULTIPART_MAX_FILE_SIZE=10MB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    // Require the extension to match — a client can fake mimetype but the
    // filename is the clear user-intent signal. Accept .xlsx and .xls.
    if (!/\.xlsx?$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('only .xlsx / .xls files accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

// GET /api/admin/jobs/upload-template
// Returns an .xlsx file pre-populated with the header row + one example row.
// Mirrors the 17-column layout expected by utils/excel-parser.js — keeping the
// template here (same process as the parser) means the two can't drift.
router.get('/upload-template', (req, res, next) => {
  try {
    const headers = [
      'Customer Mobile', 'Customer Name', 'Customer Email',
      'Client', 'Client Ref ID',
      'Service Type', 'Client Service IDs',
      'Job Description', 'Requested Date/Time',
      'Address', 'City', 'PIN Code',
      'Job Owner (user_id)', 'Time Slot',
      'Job Type', 'Helper Required', 'GPS Location',
    ];
    const example = [
      '9876543210', 'Rohan Kumar', 'rohan@example.com',
      'Lenskart', 'CLIENT-REF-001',
      'Installation', '',
      'AC install at new flat', '20-04-2026 14:00',
      'G-14, Green Park', 'New Delhi', '110016',
      '', '14:00 - 16:00',
      'Installation', 'no', '28.5583,77.2030',
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    // Column widths — give the required fields a bit more room so the user
    // isn't fighting Excel's auto-sizing.
    ws['!cols'] = headers.map((h) => ({ wch: Math.max(14, Math.min(32, h.length + 4)) }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Jobs');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="easyfix-jobs-upload-template.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) { next(err); }
});

// POST /api/admin/jobs/upload?dryRun=true
// multipart/form-data: file=<xlsx>
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'missing "file" upload');
    const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';

    let parsed;
    try {
      parsed = parseBuffer(req.file.buffer);
    } catch (parseErr) {
      return modernError(res, 400, `could not parse xlsx: ${parseErr.message}`);
    }
    if (parsed.totalRows === 0) {
      return modernError(res, 400, 'xlsx has no data rows (expecting header in row 1, data from row 2)');
    }
    const report = await bulkUpload(parsed, req.user, { dryRun });

    modernOk(res, report, dryRun ? 'validation complete (no rows inserted)' : 'bulk upload complete');
  } catch (e) {
    // Multer / file-size errors have err.code; map to 400
    if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

module.exports = router;
