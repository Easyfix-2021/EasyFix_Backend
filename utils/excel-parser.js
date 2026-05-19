const XLSX = require('xlsx');

/*
 * Excel row parser for bulk job upload (rev. 2026-05-19).
 *
 * NEW 10-column "Unconfirmed Bulk Upload" format — this is the file
 * clients send EasyFix from external sources, and the same file ops
 * uploads via Jobs → Upload Jobs to seed the Unconfirmed bucket.
 * Operators then complete the rest of the details (city, pin, service
 * type, owner, time slot, etc.) via the per-row Confirm & Schedule
 * flow.
 *
 * Column layout (matches Downloads/jobUploadFormat (2).xlsx):
 *   0  Client Reference ID                              (optional but recommended)
 *   1  Customer Name                                    (REQUIRED)
 *   2  Customer Mobile Number                           (REQUIRED, 10 digits)
 *   3  Service Delivery Address                         (REQUIRED, free text)
 *   4  Date of Appointment (dd-mm-yyyy)                 (REQUIRED)
 *   5  Product Quantity                                 (optional, int)
 *   6  Mode of Payment (Free for customer | Paid by Customer)
 *   7  Type of Service (Installation | Repair | UnInstallation)
 *   8  Job Description
 *   9  Special Comments
 *
 * Differences vs. the deprecated 17-col format:
 *   - No per-row client column — operator picks ONE client for the
 *     whole batch on the upload form. Saves the batch from having to
 *     deal with mixed clients in a single file (the legacy spec only
 *     ever had one client per file in practice too).
 *   - No city / pin / service type / owner / time slot / GPS columns.
 *     Those land via the Confirm flow on each Unconfirmed row.
 *   - Dates are date-only (dd-mm-yyyy) — no time component. We default
 *     the time of day to 12:00 (noon) so the row passes Joi's date
 *     validator; the operator nudges it during Confirm.
 *
 * Returns:
 *   { rows: [{ rowNumber, skipReason?, raw, parsed }], totalRows, skipCount }
 * `rowNumber` is the 1-indexed Excel row (header = 1).
 */

const COLUMN_MAP = {
  0: 'client_ref_id',
  1: 'customer_name',
  2: 'customer_mob_no',
  3: 'address',
  4: 'date_of_appointment',
  5: 'product_quantity',
  6: 'mode_of_payment',
  7: 'service_type',
  8: 'job_desc',
  9: 'special_comments',
};

const ALLOWED_JOB_TYPES = new Set(['installation', 'repair', 'uninstallation']);
// Canonical casing map — "UnInstallation" preserves the capital I, not
// the simple title-case `Uninstallation` that `charAt(0).toUpperCase()`
// would produce. Matches the legacy form ops uses.
const CANONICAL_JOB_TYPE = {
  installation: 'Installation',
  repair: 'Repair',
  uninstallation: 'UnInstallation',
};

function cellToString(cell) {
  if (cell == null) return '';
  return String(cell).trim();
}

/*
 * Date parser — accepts:
 *   - JS Date (when SheetJS auto-converts a real date cell)
 *   - "dd-mm-yyyy" or "dd/mm/yyyy" string  (legacy client convention)
 *   - "dd-mm-yyyy HH:mm" string             (forward-compat with the 17-col format)
 *   - ISO 8601 string                       (fallback)
 *
 * Returns a JS Date or null.
 *
 * Date-only inputs are stamped at **midnight IST (00:00)** as a
 * sentinel meaning "ops must pick a time during Confirm". The Confirm
 * modal detects midnight-from-excel rows and blanks the time + time-
 * slot inputs so the operator is forced to make an explicit choice.
 * The Section 2 mandatory-field gate then doesn't unlock until both
 * are filled. See toFormShape() in JobModal.tsx for the FE half.
 */
function parseDateCell(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return raw;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const [, d, mo, y, h, mi] = m;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    // Midnight sentinel for date-only. If the operator explicitly
    // typed "dd-mm-yyyy HH:mm" we preserve their time choice.
    const hour = h != null ? Number(h) : 0;
    const minute = mi != null ? Number(mi) : 0;
    const date = new Date(year, Number(mo) - 1, Number(d), hour, minute);
    if (!isNaN(date)) return date;
  }
  const iso = new Date(s);
  return isNaN(iso) ? null : iso;
}

function parseBuffer(buffer, { sheetIndex = 0 } = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[sheetIndex];
  if (!sheetName) {
    throw Object.assign(new Error(`sheet ${sheetIndex} not found`), { status: 400 });
  }
  const sheet = workbook.Sheets[sheetName];
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
    if (mobile.length === 0
        && !cellToString(raw.customer_name)
        && !cellToString(raw.client_ref_id)) {
      // entirely blank row — silently skip (no skipCount bump)
      return;
    }
    if (!/^\d{10}$/.test(mobile)) {
      rows.push({ rowNumber, skipReason: `invalid mobile "${mobile}"`, raw });
      skipCount++;
      return;
    }

    // Type of Service — accepts a single value OR a comma-separated
    // multi-select like "Installation, Repair". Split, trim, lowercase
    // each token; if every token is in the whitelist, join the
    // canonical-case forms back together. Any unknown token returns
    // null and the row's validate() step surfaces a "unrecognised
    // Type of Service" error. Empty cell → null (job_type defaults
    // to 'Installation' downstream in the upload service).
    const rawType = cellToString(raw.service_type);
    const jobType = (() => {
      if (!rawType) return null;
      const tokens = rawType.split(',').map((t) => t.trim()).filter(Boolean);
      if (tokens.length === 0) return null;
      const canonical = [];
      for (const t of tokens) {
        const key = t.toLowerCase();
        if (!ALLOWED_JOB_TYPES.has(key)) return null;
        canonical.push(CANONICAL_JOB_TYPE[key]);
      }
      // Dedupe while preserving operator's first-seen order.
      return Array.from(new Set(canonical)).join(', ');
    })();

    // Mode of payment is text — kept as-is for the remarks prefix; the
    // upload service decides how to map it to a tbl_job column.
    const modeOfPayment = cellToString(raw.mode_of_payment) || null;

    const qty = (() => {
      const s = cellToString(raw.product_quantity);
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    })();

    const parsed = {
      customer: {
        customer_name: cellToString(raw.customer_name),
        customer_mob_no: mobile,
      },
      client_ref_id: cellToString(raw.client_ref_id) || undefined,
      requested_date_time: parseDateCell(raw.date_of_appointment),
      address: {
        // Free-text address; city/pin/GPS are filled during Confirm.
        address: cellToString(raw.address),
      },
      product_quantity: qty,
      mode_of_payment: modeOfPayment,
      service_type_raw: rawType || null,
      job_type: jobType,
      job_desc: cellToString(raw.job_desc) || undefined,
      special_comments: cellToString(raw.special_comments) || undefined,
    };

    rows.push({ rowNumber, raw, parsed });
  });

  return { rows, totalRows: Math.max(0, aoa.length - 1), skipCount };
}

module.exports = { parseBuffer, COLUMN_MAP, ALLOWED_JOB_TYPES };
