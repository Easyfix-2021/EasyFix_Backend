/*
 * Helpers for the /api/integration/v1/* legacy-shape endpoints.
 * Job status codes → human-readable strings EXACTLY as the Dropwizard service returned.
 */

const STATUS_LABELS = {
  0: 'Unconfirmed', 1: 'Scheduled', 2: 'In-Progress',
  3: 'Completed', 5: 'Completed', 6: 'Cancelled',
  7: 'Enquiry', 9: 'Call Later', 10: 'Revisit',
};

function statusLabel(code) {
  return STATUS_LABELS[Number(code)] || 'Unknown';
}

// Dropwizard parses "DD-MM-YYYY HH:mm" (India common format). Use this for IN and OUT.
function parseLegacyDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) {
    const iso = new Date(s);
    return isNaN(iso) ? null : iso;
  }
  const [, d, mo, y, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0));
}

function formatLegacyDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

module.exports = { STATUS_LABELS, statusLabel, parseLegacyDate, formatLegacyDate };
