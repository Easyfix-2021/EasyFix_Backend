const XLSX = require('xlsx');

/*
 * Excel row parser for bulk job upload.
 *
 * Legacy column layout (matches EasyFix_CRM's readBooksFromExcelFile):
 *   0  Customer Mobile (REQUIRED, 10 digits — rows with other lengths are skipped)
 *   1  Customer Name
 *   2  Customer Email
 *   3  Client Name (resolved to fk_client_id) OR numeric client_id
 *   4  Client Ref ID
 *   5  Service Type Name (resolved to fk_service_type_id) OR numeric
 *   6  Client Service IDs (CSV of tbl_client_service IDs)
 *   7  Job Description
 *   8  Requested Date/Time (Excel date cell OR "DD-MM-YYYY HH:mm" string)
 *   9  Address
 *   10 City Name (resolved to city_id) OR numeric city_id
 *   11 PIN Code
 *   12 Job Owner (user_id)
 *   13 Time Slot (optional extension)
 *   14 Job Type (Installation/Repair, default Installation)
 *   15 Helper Required (yes/no, default no)
 *   16 GPS Location (lat,lng)
 *
 * Returns:
 *   { rows: [{ rowNumber, skipReason?, raw, parsed }], totalRows, skipCount }
 * rowNumber is 1-indexed Excel row (header = 1).
 */

const COLUMN_MAP = {
  0: 'customer_mob_no',
  1: 'customer_name',
  2: 'customer_email',
  3: 'client',
  4: 'client_ref_id',
  5: 'service_type',
  6: 'client_service_ids',
  7: 'job_desc',
  8: 'requested_date_time',
  9: 'address',
  10: 'city',
  11: 'pin_code',
  12: 'job_owner',
  13: 'time_slot',
  14: 'job_type',
  15: 'helper_req',
  16: 'gps_location',
};

function cellToString(cell) {
  if (cell == null) return '';
  return String(cell).trim();
}

function parseDateCell(raw) {
  if (raw == null || raw === '') return null;
  // If SheetJS already converted to JS Date
  if (raw instanceof Date) return raw;
  // If string in "DD-MM-YYYY HH:mm" or similar
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const [, d, mo, y, h, mi] = m;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const date = new Date(year, Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0));
    if (!isNaN(date)) return date;
  }
  // ISO fallback
  const iso = new Date(s);
  return isNaN(iso) ? null : iso;
}

function parseBooleanish(v) {
  if (v == null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return ['yes', 'y', 'true', '1'].includes(s);
}

function parseBuffer(buffer, { sheetIndex = 0 } = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[sheetIndex];
  if (!sheetName) {
    throw Object.assign(new Error(`sheet ${sheetIndex} not found`), { status: 400 });
  }
  const sheet = workbook.Sheets[sheetName];

  // header:1 gives array of arrays, defval:'' keeps empty cells as empty strings
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

  const rows = [];
  let skipCount = 0;

  aoa.forEach((cells, i) => {
    const rowNumber = i + 1;
    if (i === 0) return; // header row

    const raw = {};
    Object.entries(COLUMN_MAP).forEach(([col, field]) => {
      const v = cells[Number(col)];
      raw[field] = v == null ? '' : v;
    });

    const mobile = cellToString(raw.customer_mob_no).replace(/\s/g, '');
    if (mobile.length === 0) {
      return; // entirely blank row — silently skip (no skipCount bump)
    }
    if (!/^\d{10}$/.test(mobile)) {
      rows.push({ rowNumber, skipReason: `invalid mobile "${mobile}"`, raw });
      skipCount++;
      return;
    }

    const parsed = {
      customer: {
        customer_name: cellToString(raw.customer_name),
        customer_mob_no: mobile,
        customer_email: cellToString(raw.customer_email) || undefined,
      },
      client: cellToString(raw.client),
      client_ref_id: cellToString(raw.client_ref_id) || undefined,
      service_type: cellToString(raw.service_type) || undefined,
      client_service_ids: cellToString(raw.client_service_ids) || undefined,
      job_desc: cellToString(raw.job_desc) || undefined,
      requested_date_time: parseDateCell(raw.requested_date_time),
      address: {
        address: cellToString(raw.address),
        pin_code: cellToString(raw.pin_code),
        gps_location: cellToString(raw.gps_location) || undefined,
        city: cellToString(raw.city),
      },
      job_owner: raw.job_owner === '' ? undefined : Number(raw.job_owner),
      time_slot: cellToString(raw.time_slot) || undefined,
      job_type: cellToString(raw.job_type) || 'Installation',
      helper_req: parseBooleanish(raw.helper_req),
    };

    rows.push({ rowNumber, raw, parsed });
  });

  return { rows, totalRows: aoa.length - 1, skipCount };
}

module.exports = { parseBuffer, COLUMN_MAP };
