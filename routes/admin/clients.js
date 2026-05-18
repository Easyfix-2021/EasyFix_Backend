const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const { buildRequestScope, assertEntityInScope } = require('../../lib/scope');

// ─── Clients CRUD ───────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { q, includeInactive } = req.query;
    const clauses = [];
    const params = [];
    // RBAC: restrict the visible client list to the caller's
    // manage_clients AND manage_verticals scope. `clients` directly
    // filters by client_id; `verticals` filters by tbl_client.vertical_id.
    const scope = buildRequestScope(req);
    if (scope?.clients) {
      const c = scope.clients;
      if (c.mode === 'none') clauses.push('1=0');
      else if (c.mode === 'allow' && c.ids.length) {
        clauses.push(`client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
    }
    if (scope?.verticals) {
      const v = scope.verticals;
      if (v.mode === 'none') clauses.push('1=0');
      else if (v.mode === 'allow' && v.ids.length) {
        clauses.push(`vertical_id IN (${v.ids.map(() => '?').join(',')})`);
        params.push(...v.ids);
      }
    }
    if (includeInactive !== 'true') clauses.push('client_status = 1');
    if (q) { clauses.push('client_name LIKE ?'); params.push(`%${q}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    params.push(limit, offset);
    const [rows] = await pool.query(
      `SELECT client_id, client_name, client_email, client_status, client_type, reference_code, booking_cut_off, vertical_id
         FROM tbl_client ${where} ORDER BY client_name LIMIT ? OFFSET ?`, params);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM tbl_client WHERE client_id = ?', [req.params.id]);
    if (!c) return modernError(res, 404, 'client not found');
    const guard = assertEntityInScope(req, { client_id: c.client_id, vertical_id: c.vertical_id });
    if (!guard.ok) return modernError(res, 404, 'client not found');
    modernOk(res, c);
  } catch (e) { next(e); }
});

router.post('/', validate(Joi.object({
  clientName: Joi.string().max(255).required(),
  clientEmail: Joi.string().email().max(255).optional(),
  clientAddress: Joi.string().max(500).optional(),
  clientType: Joi.string().max(50).optional(),
  referenceCode: Joi.string().max(50).optional(),
  bookingCutOff: Joi.number().integer().optional(),
})), async (req, res, next) => {
  try {
    const [ins] = await pool.query(
      `INSERT INTO tbl_client (client_name, client_email, client_address, client_type, reference_code, booking_cut_off, client_status, insert_date, update_date, inserted_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), NOW(), ?)`,
      [req.body.clientName, req.body.clientEmail || null, req.body.clientAddress || null,
       req.body.clientType || null, req.body.referenceCode || null, req.body.bookingCutOff || null, req.user.user_id]);
    res.status(201);
    modernOk(res, { client_id: ins.insertId });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const allowed = ['client_name', 'client_email', 'client_address', 'client_status', 'client_type', 'reference_code', 'booking_cut_off', 'max_orders', 'travel_distance'];
    const sets = [], vals = [];
    for (const k of allowed) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
    if (sets.length === 0) return modernError(res, 400, 'nothing to update');
    sets.push('update_date = NOW()', 'updated_by = ?');
    vals.push(req.user.user_id, req.params.id);
    await pool.query(`UPDATE tbl_client SET ${sets.join(', ')} WHERE client_id = ?`, vals);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

// ─── Client Contacts (SPOCs) ────────────────────────────────────────
router.get('/:clientId/contacts', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM tbl_client_contacts WHERE client_id = ? ORDER BY id DESC', [req.params.clientId]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/:clientId/contacts', validate(Joi.object({
  contactName: Joi.string().max(200).required(),
  contactEmail: Joi.string().email().required(),
  contactNo: Joi.string().pattern(/^[0-9]{10}$/).required(),
  contactDesgn: Joi.string().max(100).optional(),
  managerId: Joi.number().integer().optional(),
})), async (req, res, next) => {
  try {
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_contacts (client_id, contact_name, contact_email, contact_no, contact_desgn, manager_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [req.params.clientId, req.body.contactName, req.body.contactEmail, req.body.contactNo, req.body.contactDesgn || null, req.body.managerId || null]);
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

router.put('/contacts/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const allowed = ['contact_name', 'contact_email', 'contact_no', 'contact_alt_no', 'contact_desgn', 'manager_id', 'status'];
    const sets = [], vals = [];
    for (const k of allowed) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
    if (sets.length === 0) return modernError(res, 400, 'nothing to update');
    vals.push(req.params.id);
    await pool.query(`UPDATE tbl_client_contacts SET ${sets.join(', ')} WHERE id = ?`, vals);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

// ─── Client Billing ─────────────────────────────────────────────────
router.get('/:clientId/billing', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tbl_client_billing WHERE client_id = ?', [req.params.clientId]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/:clientId/billing', async (req, res, next) => {
  try {
    const b = req.body || {};
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_billing (client_id, c_bill_name, c_bill_address, c_bill_comm_addr, c_bill_city_id, c_bill_pin, c_bill_email, c_bill_freq_type, c_bill_payment_cycle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.clientId, b.name, b.address, b.commAddr || null, b.cityId, b.pin, b.email || null, b.frequencyType || null, b.paymentCycle || null]);
    res.status(201);
    modernOk(res, { c_bill_id: ins.insertId });
  } catch (e) { next(e); }
});

// ─── Client Custom Properties ──────────────────────────────────────
/*
 * GET /api/admin/clients/:clientId/custom-properties
 *
 * Returns an array of the client's configured custom properties,
 * normalised to a stable shape regardless of underlying column-name
 * conventions in `tbl_client_custom_properties`.
 *
 * Response shape (per row):
 *   { name: string, label: string | null, mandatory: boolean,
 *     value: string | null, raw: <original row> }
 *
 *   - `name` is lowercased + trimmed for case-insensitive lookup
 *     on the FE. Common variants accepted: property_name / name /
 *     key / field_name.
 *   - `mandatory` accepts: is_mandatory / mandatory / required /
 *     is_required. Coerced to boolean (1/0, true/false, "1"/"0",
 *     "yes"/"no" all handled).
 *   - `label` is optional display text. Falls back to null; the FE
 *     decides the user-facing label per property name.
 *   - `value` is the configured property value (if any). May drive
 *     things like "preferred Collected By" — see the dedicated
 *     `/collected-by-preference` endpoint for that case.
 *   - `raw` is the entire DB row, kept so future fields don't need
 *     a BE change to surface — FE can drill in.
 *
 * Drives in the Book-New-Call flow:
 *   - Whether to render the "Branch Details", "Property / Building
 *     Name", "Product Code" inputs at all (only when the
 *     corresponding property row exists for this client).
 *   - Whether each rendered input is required (driven by `mandatory`).
 */
router.get('/:clientId/custom-properties', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tbl_client_custom_properties WHERE client_id = ?', [req.params.clientId]);
    const truthy = (v) => {
      if (v == null) return false;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      const s = String(v).trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'y';
    };
    const normalised = rows.map((r) => ({
      name: String(r.property_name ?? r.name ?? r.key ?? r.field_name ?? '').toLowerCase().trim(),
      label: r.property_label ?? r.label ?? r.display_name ?? null,
      mandatory: truthy(r.is_mandatory ?? r.mandatory ?? r.required ?? r.is_required ?? r.is_required_field),
      value: r.property_value ?? r.value ?? r.field_value ?? null,
      raw: r,
    })).filter((p) => p.name);
    modernOk(res, normalised);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/clients/:clientId/collected-by-preference
 *
 * Returns the client's preferred "Collected By" setting for new
 * bookings. Drives the lock state of the "Collected By" dropdown in
 * the Book-New-Call modal:
 *   - preferred = null                 → dropdown enabled, all options
 *   - preferred = "Easyfixer"          → preselected + disabled
 *   - preferred = "Easyfix"            → preselected + disabled
 *   - preferred = "Client"             → preselected + disabled
 *
 * Source: `tbl_client.collected_by` integer column. Confirmed by ops
 * 2026-05-18 via `SELECT DISTINCT collected_by FROM tbl_client`:
 *   0 = any  (no lock — operator picks)
 *   1 = Easyfixer
 *   2 = Easyfix
 *   3 = Client
 * Anything else (NULL, unknown value) → treated as "any" so a future
 * code value doesn't break the booking flow before this map is
 * updated.
 */
const COLLECTED_BY_MAP = {
  1: 'Easyfixer',
  2: 'Easyfix',
  3: 'Client',
};

router.get('/:clientId/collected-by-preference', async (req, res, next) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return modernError(res, 400, 'invalid clientId');
    }

    let preferred = null;
    let source = 'default';
    try {
      const [rows] = await pool.query(
        'SELECT collected_by FROM tbl_client WHERE client_id = ? LIMIT 1',
        [clientId],
      );
      if (rows.length) {
        const code = Number(rows[0].collected_by);
        if (Number.isFinite(code) && COLLECTED_BY_MAP[code]) {
          preferred = COLLECTED_BY_MAP[code];
          source = 'client';
        } else if (code === 0) {
          // Explicit "any" — still a configured value, not the absence
          // of one. Surfaced as source=client so callers can tell the
          // difference vs. an unknown/missing field.
          preferred = null;
          source = 'client';
        }
      }
    } catch (e) {
      // Defensive: if the `collected_by` column doesn't exist on this
      // DB's `tbl_client`, fall back to "any" rather than 500.
      // eslint-disable-next-line no-console
      console.warn('[collected-by-pref] tbl_client.collected_by read failed — falling back to "any":', e?.message);
    }

    modernOk(res, { preferred, source });
  } catch (e) { next(e); }
});

module.exports = router;
