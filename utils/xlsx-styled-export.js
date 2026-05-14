const ExcelJS = require('exceljs');

/*
 * Reusable styled-XLSX builder/streamer.
 *
 * Used by report-style endpoints that need to ship a downloadable
 * Excel of tabular data with a consistent visual identity. First
 * caller: GET /admin/call-info/export.xlsx (2026-05-14). Anticipated
 * callers: Completed-Jobs report, Easyfixer payout sheet, etc.
 *
 * Visual recipe (matches the EasyFix CRM Metronic palette):
 *   - Row 1 — brand title band (deep sky #1E6FBE, white bold 18pt).
 *   - Row 2 — meta summary band (light sky #DBEAFE, indigo 11pt).
 *   - Row 3 — 4px spacer.
 *   - Row 4 — column headers (Metronic blue #2E86DE, white bold,
 *             centered, all-bordered, FROZEN below).
 *   - Rows 5+ — data with alternating white / #F8FAFC banding and
 *               hairline #E2E8F0 borders.
 *
 * Usage pattern:
 *
 *   const wb = buildStyledWorkbook({
 *     title: 'EasyFix · Call History',
 *     meta:  'Range: 2026-05-13 → 2026-05-14 · 42 calls',
 *     sheetName: 'Call History',
 *     columns: [
 *       { header: 'Call Time',    key: 'time',     width: 22, align: 'left'   },
 *       { header: 'Easyfixer',    key: 'name',     width: 28, align: 'left'   },
 *       { header: 'Mobile',       key: 'mobile',   width: 16, align: 'center' },
 *     ],
 *     rows: [
 *       { time: '13-May-2026 14:32', name: 'Anil Kumar', mobile: '93xxxx' },
 *       …
 *     ],
 *     emptyMessage: 'No calls found.',  // optional
 *   });
 *
 *   // Either compose more sheets onto `wb` and write yourself, or:
 *   await streamStyledXlsx(res, 'call-history.xlsx', { title, meta, … });
 */

// Palette — kept as constants so a future "rebrand pass" only edits
// one place. All ARGB to satisfy ExcelJS's color contract.
const BRAND_DEEP    = 'FF1E6FBE';
const BRAND_PRIMARY = 'FF2E86DE';
const BRAND_LIGHT   = 'FFDBEAFE';
const STRIPE        = 'FFF8FAFC';
const BORDER_GREY   = 'FFE2E8F0';
const TEXT_INDIGO   = 'FF1E40AF';
const TEXT_DARK     = 'FF111827';
const TEXT_MUTED    = 'FF6B7280';
const WHITE         = 'FFFFFFFF';

/**
 * Build a styled workbook + worksheet. Returns the workbook so the
 * caller can attach more sheets or finalise streaming itself.
 *
 * @param {Object}  o
 * @param {string}  o.title         Brand-band title text.
 * @param {string=} o.meta          Meta-band summary text (optional).
 * @param {string=} o.sheetName     Worksheet name (default = first 31
 *                                  chars of title or "Sheet1").
 * @param {Array<{header:string,key:string,width:number,align?:'left'|'center'|'right'}>} o.columns
 * @param {Array<Object>} o.rows    Row objects keyed by column.key.
 * @param {string=} o.emptyMessage  Shown when rows is empty (default
 *                                  "No rows.").
 */
function buildStyledWorkbook({
  title, meta, sheetName, columns, rows, emptyMessage,
}) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('buildStyledWorkbook: columns required');
  }
  const safeRows = Array.isArray(rows) ? rows : [];
  const name = (sheetName || title || 'Sheet1').slice(0, 31);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix CRM';
  wb.created = new Date();

  // ySplit=4 freezes everything above row 5 (title + meta + spacer + header).
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4 }] });

  // ── Row 1 — title band ─────────────────────────────────────────────────
  ws.mergeCells(1, 1, 1, columns.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title || '';
  titleCell.font = { name: 'Calibri', size: 18, bold: true, color: { argb: WHITE } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_DEEP } };
  ws.getRow(1).height = 30;

  // ── Row 2 — meta summary band ──────────────────────────────────────────
  ws.mergeCells(2, 1, 2, columns.length);
  const metaCell = ws.getCell(2, 1);
  metaCell.value = meta || '';
  metaCell.font = { name: 'Calibri', size: 11, color: { argb: TEXT_INDIGO } };
  metaCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  metaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_LIGHT } };
  ws.getRow(2).height = 20;

  // ── Row 3 — spacer ─────────────────────────────────────────────────────
  ws.getRow(3).height = 4;

  // ── Row 4 — column headers ─────────────────────────────────────────────
  columns.forEach((col, idx) => {
    const colIdx = idx + 1;
    ws.getColumn(colIdx).width = col.width || 18;
    const hc = ws.getCell(4, colIdx);
    hc.value = col.header;
    hc.font = { name: 'Calibri', size: 11, bold: true, color: { argb: WHITE } };
    hc.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_PRIMARY } };
    hc.border = {
      top:    { style: 'thin', color: { argb: BRAND_DEEP } },
      bottom: { style: 'thin', color: { argb: BRAND_DEEP } },
      left:   { style: 'thin', color: { argb: BRAND_DEEP } },
      right:  { style: 'thin', color: { argb: BRAND_DEEP } },
    };
  });
  ws.getRow(4).height = 22;

  // ── Data rows ──────────────────────────────────────────────────────────
  if (safeRows.length === 0) {
    ws.mergeCells(5, 1, 5, columns.length);
    const c = ws.getCell(5, 1);
    c.value = emptyMessage || 'No rows.';
    c.font = { name: 'Calibri', size: 11, italic: true, color: { argb: TEXT_MUTED } };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(5).height = 28;
  } else {
    safeRows.forEach((row, i) => {
      const rowIdx = 5 + i;
      const banded = i % 2 === 1;
      columns.forEach((col, cIdx) => {
        const cell = ws.getCell(rowIdx, cIdx + 1);
        // Read column value via key; coerce null/undefined to ''.
        const v = row[col.key];
        cell.value = v == null ? '' : v;
        cell.font = { name: 'Calibri', size: 10, color: { argb: TEXT_DARK } };
        cell.alignment = {
          vertical: 'middle',
          horizontal: col.align || 'center',
          wrapText: false,
        };
        if (banded) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE } };
        }
        cell.border = {
          top:    { style: 'hair', color: { argb: BORDER_GREY } },
          bottom: { style: 'hair', color: { argb: BORDER_GREY } },
          left:   { style: 'hair', color: { argb: BORDER_GREY } },
          right:  { style: 'hair', color: { argb: BORDER_GREY } },
        };
      });
      ws.getRow(rowIdx).height = 18;
    });
  }

  return wb;
}

/**
 * One-shot helper: build the workbook with the recipe above, set the
 * download response headers, and stream the XLSX to `res`.
 *
 * Call this from a route handler when there's nothing custom to add
 * to the workbook (single-sheet styled export). For multi-sheet or
 * custom-formula workbooks, use `buildStyledWorkbook()` directly and
 * write to the response yourself.
 *
 * @param {import('express').Response} res
 * @param {string} filename  e.g. "call-history_2026-05-14.xlsx".
 * @param {Object} opts      Same shape as buildStyledWorkbook input.
 */
async function streamStyledXlsx(res, filename, opts) {
  const wb = buildStyledWorkbook(opts);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  // RFC 5987 fallback — the simple form is enough for ASCII names, and
  // every caller today uses ASCII. If a future caller has non-ASCII
  // text in the filename, swap in `filename*=UTF-8''…` encoded form.
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = {
  buildStyledWorkbook,
  streamStyledXlsx,
  // Re-export the palette so siblings can stay visually consistent
  // when they need custom styling.
  PALETTE: {
    BRAND_DEEP, BRAND_PRIMARY, BRAND_LIGHT, STRIPE, BORDER_GREY,
    TEXT_INDIGO, TEXT_DARK, TEXT_MUTED, WHITE,
  },
};
