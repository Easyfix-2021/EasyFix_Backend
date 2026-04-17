const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

// ─── Clients CRUD ───────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { q, includeInactive } = req.query;
    const clauses = [];
    const params = [];
    if (includeInactive !== 'true') clauses.push('client_status = 1');
    if (q) { clauses.push('client_name LIKE ?'); params.push(`%${q}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    params.push(limit, offset);
    const [rows] = await pool.query(
      `SELECT client_id, client_name, client_email, client_status, client_type, reference_code, booking_cut_off
         FROM tbl_client ${where} ORDER BY client_name LIMIT ? OFFSET ?`, params);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM tbl_client WHERE client_id = ?', [req.params.id]);
    if (!c) return modernError(res, 404, 'client not found');
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
router.get('/:clientId/custom-properties', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tbl_client_custom_properties WHERE client_id = ?', [req.params.clientId]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
