const XLSX = require('xlsx');

/*
 * Stream an array of row objects to the response as an .xlsx download.
 *
 * columns: [{ key: 'job_id', header: 'Job ID', width?: 14 }, ...]
 * rows:    [{ job_id: 1, ... }, ...]
 *
 * Header order follows the columns array. Values are pulled by `key`; nulls
 * render as empty cells. Date instances are written as Excel date cells
 * (cellDates option preserved on the workbook).
 */
function sendXlsx(res, { filename, sheetName = 'Sheet1', columns, rows }) {
  const headers = columns.map((c) => c.header);
  const aoa = [headers, ...rows.map((r) => columns.map((c) => normalize(r[c.key])))];

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  ws['!cols'] = columns.map((c) => ({ wch: c.width || Math.max(12, c.header.length + 4) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

function normalize(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

module.exports = { sendXlsx };
