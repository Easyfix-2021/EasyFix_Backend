const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireSpocAuth = require('../../middleware/client-auth');
const { pool } = require('../../db');
const clientAuth = require('../../services/client-auth.service');
const jobService = require('../../services/job.service');
const { modernOk, modernError } = require('../../utils/response');

// ─── Public: SPOC OTP login ─────────────────────────────────────────
const identifier = Joi.alternatives(Joi.string().email(), Joi.string().pattern(/^[0-9]{10}$/));

router.post('/auth/login-otp', validate(Joi.object({ identifier: identifier.required() })), async (req, res, next) => {
  try {
    const r = await clientAuth.createLoginOtp(req.body.identifier);
    modernOk(res, { delivered: r.found, expiresAt: r.expiresAt || null });
  } catch (e) { next(e); }
});

router.post('/auth/verify-otp', validate(Joi.object({
  identifier: identifier.required(),
  otp: Joi.number().integer().min(1000).max(9999).required(),
})), async (req, res, next) => {
  try {
    const r = await clientAuth.verifyLoginOtp(req.body.identifier, req.body.otp);
    if (!r.ok) return modernError(res, 401, r.reason);
    res.cookie('spocToken', r.token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    modernOk(res, { token: r.token, spoc: { id: r.spoc.id, name: r.spoc.contact_name, client_id: r.spoc.client_id } });
  } catch (e) { next(e); }
});

// ─── Protected ──────────────────────────────────────────────────────
router.use(requireSpocAuth);

router.get('/me', (req, res) => modernOk(res, { spoc: req.spoc }));

router.get('/dashboard', async (req, res, next) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        SUM(CASE WHEN job_status IN (0,7,9) THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN job_status = 1 THEN 1 ELSE 0 END) AS scheduled,
        SUM(CASE WHEN job_status = 2 THEN 1 ELSE 0 END) AS inProgress,
        SUM(CASE WHEN job_status IN (3,5) THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN job_status = 6 THEN 1 ELSE 0 END) AS cancelled,
        COUNT(*) AS total
       FROM tbl_job WHERE fk_client_id = ?`, [req.spoc.client_id]);
    modernOk(res, stats);
  } catch (e) { next(e); }
});

router.get('/jobs', async (req, res, next) => {
  try {
    const { rows, total } = await jobService.list({
      clientId: req.spoc.client_id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      q: req.query.q,
      limit: Math.min(Number(req.query.limit) || 50, 500),
      offset: Number(req.query.offset) || 0,
    });
    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    modernOk(res, job);
  } catch (e) { next(e); }
});

// Approve / reject / escalate
router.patch('/jobs/:id/approve', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    await pool.query('UPDATE tbl_job SET approved_by_client_contact = ?, approved_on_date_time = NOW() WHERE job_id = ?',
      [req.spoc.id, job.job_id]);
    modernOk(res, await jobService.getById(job.job_id), 'approved');
  } catch (e) { next(e); }
});

router.patch('/jobs/:id/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    await pool.query(
      'UPDATE tbl_job SET approval_reject_reason = ?, approval_reject_date_time = NOW() WHERE job_id = ?',
      [req.body.reason, job.job_id]);
    modernOk(res, await jobService.getById(job.job_id), 'rejected');
  } catch (e) { next(e); }
});

// Estimate approve/reject — legacy stored in approve_job_doc workflow; keeping simple
router.patch('/jobs/:id/estimate/approve', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    await pool.query(
      'UPDATE tbl_job SET approved_by_client_contact = ?, approved_on_date_time = NOW() WHERE job_id = ?',
      [req.spoc.id, job.job_id]);
    modernOk(res, { approved: true });
  } catch (e) { next(e); }
});

router.patch('/jobs/:id/estimate/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    await pool.query(
      'UPDATE tbl_job SET approval_reject_reason = ?, approval_reject_date_time = NOW() WHERE job_id = ?',
      [req.body.reason, job.job_id]);
    modernOk(res, { rejected: true });
  } catch (e) { next(e); }
});

// Create job as SPOC (reuses internal service; fk_client_id locked to SPOC's client)
router.post('/jobs', async (req, res, next) => {
  try {
    const created = await jobService.create({ ...req.body, fk_client_id: req.spoc.client_id }, { user_id: null });
    res.status(201);
    modernOk(res, created, 'job created');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/profile', async (req, res, next) => {
  try {
    const [[profile]] = await pool.query(
      'SELECT id, contact_name, contact_email, contact_no, contact_alt_no, contact_desgn, linkedIn_profile FROM tbl_client_contacts WHERE id = ?',
      [req.spoc.id]);
    modernOk(res, profile);
  } catch (e) { next(e); }
});

router.put('/profile', async (req, res, next) => {
  try {
    const { contact_name, contact_alt_no, contact_desgn, linkedIn_profile } = req.body || {};
    await pool.query(
      `UPDATE tbl_client_contacts
          SET contact_name = COALESCE(?, contact_name),
              contact_alt_no = COALESCE(?, contact_alt_no),
              contact_desgn = COALESCE(?, contact_desgn),
              linkedIn_profile = COALESCE(?, linkedIn_profile)
        WHERE id = ?`,
      [contact_name, contact_alt_no, contact_desgn, linkedIn_profile, req.spoc.id]);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.get('/contacts/managers', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, contact_name, contact_email, contact_no
         FROM tbl_client_contacts WHERE client_id = ? AND status = 1 ORDER BY contact_name`,
      [req.spoc.client_id]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/export/jobs', async (req, res, next) => {
  try {
    const { rows } = await jobService.list({
      clientId: req.spoc.client_id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      limit: 500,
    });
    modernOk(res, { count: rows.length, rows, note: 'Excel export — CSV stream TBD in Phase 11' });
  } catch (e) { next(e); }
});

module.exports = router;
