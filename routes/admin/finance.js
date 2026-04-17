const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

// ─── Invoices ───────────────────────────────────────────────────────
router.get('/invoices', async (req, res, next) => {
  try {
    const { clientId, isPaid, from, to } = req.query;
    const clauses = [], params = [];
    if (clientId != null) { clauses.push('fk_client_id = ?'); params.push(clientId); }
    if (isPaid === '1' || isPaid === 'true')  clauses.push('is_paid = 1');
    if (isPaid === '0' || isPaid === 'false') clauses.push('is_paid = 0');
    if (from) { clauses.push('billing_from_date >= ?'); params.push(from); }
    if (to)   { clauses.push('billing_to_date   <= ?'); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    params.push(limit, offset);
    const [rows] = await pool.query(
      `SELECT id, fk_client_id, billing_from_date, billing_to_date, total_invoice_amount,
              total_paid_amount, is_paid, is_raised, amount_due_date, file_path_pdf
         FROM tbl_client_invoice ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      params);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/invoices/:id', async (req, res, next) => {
  try {
    const [[inv]] = await pool.query('SELECT * FROM tbl_client_invoice WHERE id = ?', [req.params.id]);
    if (!inv) return modernError(res, 404, 'invoice not found');
    const [payments] = await pool.query('SELECT * FROM tbl_client_invoice_paid WHERE fk_invoice_id = ?', [req.params.id]);
    modernOk(res, { ...inv, payments });
  } catch (e) { next(e); }
});

router.post('/invoices/generate', validate(Joi.object({
  clientId: Joi.number().integer().positive().required(),
  from: Joi.date().iso().required(), to: Joi.date().iso().required(),
})), async (req, res, next) => {
  try {
    const { clientId, from, to } = req.body;
    // Sum of completed jobs in range — simplified; real legacy pulls job_services totals
    const [[sum]] = await pool.query(
      `SELECT COALESCE(SUM(js.total_charge * js.quantity), 0) AS total, COUNT(DISTINCT j.job_id) AS jobCount
         FROM tbl_job j LEFT JOIN tbl_job_services js ON js.job_id = j.job_id
        WHERE j.fk_client_id = ? AND j.job_status IN (3,5)
          AND j.checkout_date_time BETWEEN ? AND ?`,
      [clientId, from, to]);
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_invoice (fk_client_id, billing_from_date, billing_to_date,
          current_due_amount, total_invoice_amount, total_paid_amount, is_raised, is_paid, update_date, updated_by)
       VALUES (?, ?, ?, ?, ?, 0, 1, 0, NOW(), ?)`,
      [clientId, from, to, sum.total, sum.total, req.user.user_id]);
    res.status(201);
    modernOk(res, { invoiceId: ins.insertId, jobCount: sum.jobCount, totalAmount: sum.total }, 'invoice generated');
  } catch (e) { next(e); }
});

router.post('/invoices/:id/payment', validate(Joi.object({
  amount: Joi.number().positive().required(),
  tdsDeducted: Joi.number().min(0).optional(),
  paidDate: Joi.date().iso().optional(),
  comments: Joi.string().max(500).optional(),
})), async (req, res, next) => {
  try {
    const invId = Number(req.params.id);
    const [[inv]] = await pool.query('SELECT fk_client_id, total_invoice_amount, total_paid_amount FROM tbl_client_invoice WHERE id = ?', [invId]);
    if (!inv) return modernError(res, 404, 'invoice not found');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO tbl_client_invoice_paid (fk_invoice_id, fk_client_id, paid_amount, tds_deducted, paid_date, paid_by, comments, insert_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [invId, inv.fk_client_id, req.body.amount, req.body.tdsDeducted || 0, req.body.paidDate || new Date(), req.user.user_id, req.body.comments || null]);
      const newPaid = Number(inv.total_paid_amount) + Number(req.body.amount);
      const fullyPaid = newPaid >= Number(inv.total_invoice_amount) ? 1 : 0;
      await conn.query(
        `UPDATE tbl_client_invoice SET total_paid_amount = ?, is_paid = ?, update_date = NOW(), updated_by = ? WHERE id = ?`,
        [newPaid, fullyPaid, req.user.user_id, invId]);
      await conn.commit();
      modernOk(res, { recorded: true, totalPaid: newPaid, isPaid: !!fullyPaid });
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  } catch (e) { next(e); }
});

router.patch('/invoices/:id/status', validate(Joi.object({
  isRaised: Joi.boolean().optional(),
  isPaid: Joi.boolean().optional(),
  comments: Joi.string().max(500).optional(),
}).min(1)), async (req, res, next) => {
  try {
    const sets = [], vals = [];
    if (req.body.isRaised !== undefined) { sets.push('is_raised = ?'); vals.push(req.body.isRaised ? 1 : 0); }
    if (req.body.isPaid !== undefined)   { sets.push('is_paid = ?');   vals.push(req.body.isPaid ? 1 : 0); }
    if (req.body.comments)                { sets.push('updated_comments = ?'); vals.push(req.body.comments); }
    sets.push('update_date = NOW()', 'updated_by = ?');
    vals.push(req.user.user_id, req.params.id);
    await pool.query(`UPDATE tbl_client_invoice SET ${sets.join(', ')} WHERE id = ?`, vals);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

// ─── Transactions (ledger) ──────────────────────────────────────────
router.get('/transactions', async (req, res, next) => {
  try {
    const { clientId, jobId } = req.query;
    const clauses = [], params = [];
    if (clientId != null) { clauses.push('client_id = ?'); params.push(clientId); }
    if (jobId != null)    { clauses.push('job_id = ?');    params.push(jobId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT * FROM tbl_client_transaction ${where} ORDER BY client_trans_id DESC LIMIT ?`, params);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/transactions', validate(Joi.object({
  clientId: Joi.number().integer().positive().required(),
  jobId: Joi.number().integer().positive().optional(),
  transactionType: Joi.number().integer().required(),
  amount: Joi.number().required(),
  description: Joi.string().max(500).optional(),
})), async (req, res, next) => {
  try {
    const [[prior]] = await pool.query(
      'SELECT balance FROM tbl_client_transaction WHERE client_id = ? ORDER BY client_trans_id DESC LIMIT 1',
      [req.body.clientId]);
    const newBalance = (prior?.balance || 0) + req.body.amount;
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_transaction (client_id, job_id, transaction_type, amount, balance, description, transaction_date, created_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
      [req.body.clientId, req.body.jobId || null, req.body.transactionType, req.body.amount, newBalance, req.body.description || null, req.user.user_id]);
    res.status(201);
    modernOk(res, { transactionId: ins.insertId, newBalance });
  } catch (e) { next(e); }
});

// ─── Purchase Orders ────────────────────────────────────────────────
router.get('/purchase-orders', async (req, res, next) => {
  try {
    const { clientId } = req.query;
    const [rows] = await pool.query(
      `SELECT * FROM tbl_client_purchase_order_details ${clientId != null ? 'WHERE fk_client_id = ?' : ''} ORDER BY inv_po_id DESC LIMIT 500`,
      clientId != null ? [clientId] : []);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/purchase-orders', async (req, res, next) => {
  try {
    const b = req.body || {};
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_purchase_order_details
         (fk_client_id, inv_client_po_num, inv_po_desc, inv_po_start_date, inv_po_end_date, inv_po_total_amnt, inv_po_date)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [b.clientId, b.poNumber, b.description || null, b.startDate, b.endDate, b.totalAmount]);
    res.status(201);
    modernOk(res, { poId: ins.insertId });
  } catch (e) { next(e); }
});

// ─── Easyfixer payout ledger ───────────────────────────────────────
router.get('/easyfixer/:id/payout', async (req, res, next) => {
  try {
    const [[balance]] = await pool.query('SELECT efr_id, current_balance FROM tbl_easyfixer WHERE efr_id = ?', [req.params.id]);
    modernOk(res, balance || null);
  } catch (e) { next(e); }
});

router.post('/easyfixer/:id/recharge', validate(Joi.object({
  amount: Joi.number().positive().required(),
  reference: Joi.string().max(100).optional(),
})), async (req, res, next) => {
  try {
    const efrId = Number(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE tbl_easyfixer SET current_balance = COALESCE(current_balance, 0) + ?, balance_updated = NOW() WHERE efr_id = ?`,
        [req.body.amount, efrId]);
      await conn.commit();
      modernOk(res, { applied: req.body.amount });
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  } catch (e) { next(e); }
});

module.exports = router;
