const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

// ─── Quotations ─────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return modernError(res, 400, 'jobId required');
    const [rows] = await pool.query('SELECT * FROM quotation_details WHERE job_id = ? ORDER BY id DESC', [jobId]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/product', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.jobId || !b.productName) return modernError(res, 400, 'jobId and productName required');
    const [ins] = await pool.query(
      `INSERT INTO quotation_details (job_id, quotation_type, description, quantity, unit_price, total_price, created_by, created_date)
       VALUES (?, 'product', ?, ?, ?, ?, ?, NOW())`.replace('quotation_details', 'quotation_details'),
      [b.jobId, b.productName, b.quantity || 1, b.unitPrice || 0, (b.quantity || 1) * (b.unitPrice || 0), req.user.user_id]);
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

router.post('/material', async (req, res, next) => {
  try {
    const b = req.body || {};
    const [ins] = await pool.query(
      `INSERT INTO quotation_details (job_id, quotation_type, description, quantity, unit_price, total_price, created_by, created_date)
       VALUES (?, 'material', ?, ?, ?, ?, ?, NOW())`,
      [b.jobId, b.materialName, b.quantity || 1, b.unitPrice || 0, (b.quantity || 1) * (b.unitPrice || 0), req.user.user_id]);
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM quotation_details WHERE id = ?', [req.params.id]);
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

// Admin validator — mock AI pre-audit (Order Lifecycle §14)
router.post('/validate', async (req, res, next) => {
  try {
    const jobId = Number(req.body.jobId);
    if (!jobId) return modernError(res, 400, 'jobId required');
    const [items] = await pool.query('SELECT * FROM quotation_details WHERE job_id = ?', [jobId]);
    // Simple rate-card tolerance check: anomaly if unit_price > 150% of rate-card value.
    const flagged = items.filter((i) => i.unit_price > 10000); // stub threshold
    modernOk(res, { total: items.length, flaggedCount: flagged.length, flagged, note: 'stub validator — AI integration pending' });
  } catch (e) { next(e); }
});

module.exports = router;
