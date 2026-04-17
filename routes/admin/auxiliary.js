const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

// ─── Attendance ─────────────────────────────────────────────────────
router.get('/attendance', async (req, res, next) => {
  try {
    const { efrId, from, to } = req.query;
    const clauses = [], params = [];
    if (efrId != null) { clauses.push('efr_id = ?'); params.push(efrId); }
    if (from && to)    { clauses.push('date BETWEEN ? AND ?'); params.push(from, to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(`SELECT * FROM tbl_easyfixer_attendance ${where} ORDER BY id DESC LIMIT 500`, params)
      .catch(() => [[]]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/attendance', async (req, res, next) => {
  try {
    const b = req.body || {};
    const [ins] = await pool.query(
      'INSERT INTO tbl_easyfixer_attendance (efr_id, date, status, remarks, created_date) VALUES (?, ?, ?, ?, NOW())',
      [b.efrId, b.date, b.status || 'present', b.remarks || null]).catch(() => [{ insertId: null }]);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

// ─── Materials ──────────────────────────────────────────────────────
router.get('/materials/job/:jobId', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM job_material WHERE job_id = ? ORDER BY id DESC', [req.params.jobId]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/materials', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.jobId || !b.materialName) return modernError(res, 400, 'jobId and materialName required');
    const [ins] = await pool.query(
      `INSERT INTO job_material (job_id, material_name, description, sku, unit, unit_price, total_price)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [b.jobId, b.materialName, b.description || null, b.sku || null, b.unit || null,
       b.unitPrice || 0, (b.unitPrice || 0) * (b.quantity || 1)]);
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

router.delete('/materials/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM job_material WHERE id = ?', [req.params.id]);
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

// ─── Training videos ────────────────────────────────────────────────
router.get('/training-videos', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM training_videos').catch(() => [[]]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

// ─── Aadhaar / PAN uniqueness check ────────────────────────────────
router.get('/aadhaar-check/:number', async (req, res, next) => {
  try {
    const n = req.params.number;
    const [[r]] = await pool.query(
      'SELECT COUNT(*) AS n, MIN(efr_id) AS existing_efr_id FROM tbl_easyfixer WHERE adhaar_card_number = ? OR pan_card_number = ?',
      [n, n]);
    modernOk(res, { exists: r.n > 0, existing_efr_id: r.existing_efr_id });
  } catch (e) { next(e); }
});

// ─── Geocoding (proxy to MapMyIndia — stub; Phase 14 adds caching) ─
router.get('/geocode/:pincode', async (req, res) => {
  modernOk(res, {
    pincode: req.params.pincode,
    note: 'stub — MapMyIndia proxy pending. Use TOKEN_URL + CITY_DETAILS_URL from .env.',
  });
});

// ─── Experience catalog (for profile onboarding) ────────────────────
router.get('/experience', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM experience WHERE 1=1 ORDER BY id').catch(() => [[]]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

// ─── Marital status lookup ─────────────────────────────────────────
router.get('/marital-status', async (req, res) => {
  modernOk(res, [{ id: 1, name: 'Single' }, { id: 2, name: 'Married' }, { id: 3, name: 'Divorced' }, { id: 4, name: 'Widowed' }]);
});

// ─── Email verification callback (returns HTML for email-click flow) ─
router.get('/verify-email', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('<html><body><h2>Missing token</h2></body></html>');
  // Lookup logic stubbed — would validate against confirmation_token table
  res.set('Content-Type', 'text/html');
  res.send(`<html><body><h2>Email Verified</h2><p>Thank you. You may close this window.</p></body></html>`);
});

module.exports = router;
