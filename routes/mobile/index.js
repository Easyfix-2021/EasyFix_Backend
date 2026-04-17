const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireTechAuth = require('../../middleware/tech-auth');
const { pool } = require('../../db');
const techAuth = require('../../services/tech-auth.service');
const jobService = require('../../services/job.service');
const { modernOk, modernError } = require('../../utils/response');

const mobile = Joi.string().pattern(/^[0-9]{10}$/);

// ─── Auth (public) ─────────────────────────────────────────────────
router.post('/auth/login-otp', validate(Joi.object({ mobile: mobile.required() })), async (req, res, next) => {
  try {
    const r = await techAuth.createLoginOtp(req.body.mobile);
    modernOk(res, { delivered: r.found, expiresAt: r.expiresAt || null });
  } catch (e) { next(e); }
});

router.post('/auth/verify-otp', validate(Joi.object({
  mobile: mobile.required(),
  otp: Joi.number().integer().min(1000).max(9999).required(),
})), async (req, res, next) => {
  try {
    const r = await techAuth.verifyLoginOtp(req.body.mobile, req.body.otp);
    if (!r.ok) return modernError(res, 401, r.reason);
    res.cookie('techToken', r.token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    modernOk(res, { token: r.token, tech: { efr_id: r.tech.efr_id, name: r.tech.efr_name } });
  } catch (e) { next(e); }
});

// ─── Protected ─────────────────────────────────────────────────────
router.use(requireTechAuth);

router.get('/me', (req, res) => modernOk(res, { tech: req.tech }));

// Dashboard stats
router.get('/dashboard', async (req, res, next) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        SUM(CASE WHEN job_status = 0 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN job_status = 1 THEN 1 ELSE 0 END) AS scheduled,
        SUM(CASE WHEN job_status = 2 THEN 1 ELSE 0 END) AS inProgress,
        SUM(CASE WHEN job_status IN (3,5) THEN 1 ELSE 0 END) AS completed
       FROM tbl_job WHERE fk_easyfixter_id = ?`, [req.tech.efr_id]);
    modernOk(res, stats);
  } catch (e) { next(e); }
});

// Jobs assigned to me
router.get('/jobs', async (req, res, next) => {
  try {
    const { rows, total } = await jobService.list({
      easyfixerId: req.tech.efr_id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      limit: Math.min(Number(req.query.limit) || 50, 200),
    });
    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    modernOk(res, job);
  } catch (e) { next(e); }
});

router.post('/jobs/:id/accept', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await pool.query('UPDATE tbl_job SET job_status = 1, last_update_time = NOW() WHERE job_id = ? AND job_status = 0', [job.job_id]);
    modernOk(res, { accepted: true });
  } catch (e) { next(e); }
});

router.post('/jobs/:id/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await pool.query(
      `UPDATE tbl_job SET fk_easyfixter_id = NULL, scheduled_date_time = NULL, job_status = 0, last_update_time = NOW() WHERE job_id = ?`,
      [job.job_id]);
    await pool.query(
      `INSERT INTO scheduling_history (job_id, easyfixer_id, schedule_time, reason_id, reschedule_reason)
       VALUES (?, ?, NOW(), NULL, ?)`,
      [job.job_id, req.tech.efr_id, req.body.reason]);
    modernOk(res, { rejected: true });
  } catch (e) { next(e); }
});

router.post('/jobs/:id/eta', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await pool.query(
      `UPDATE tbl_job SET eta_status = ?, eta_requested_time = ?, last_update_time = NOW() WHERE job_id = ?`,
      [req.body.etaStatus || 'OTW', new Date(req.body.etaTime || Date.now()), job.job_id]);
    modernOk(res, { sent: true });
  } catch (e) { next(e); }
});

router.post('/jobs/:id/checkin', validate(Joi.object({
  gps: Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).required(),
  address: Joi.string().max(500).optional(),
  pincode: Joi.string().pattern(/^[0-9]{6}$/).optional(),
  otp: Joi.string().optional(),
})), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await pool.query(
      `UPDATE tbl_job SET checkin_date_time = NOW(), checkin_gps_location = ?, checkin_address = ?,
          checkin_pincode = ?, fk_checkin_by = ?, job_status = 2, last_update_time = NOW()
        WHERE job_id = ?`,
      [req.body.gps, req.body.address || null, req.body.pincode || null, req.tech.efr_id, job.job_id]);
    jobService.fireWebhook('TechStart', job.job_id);
    modernOk(res, { checkedIn: true });
  } catch (e) { next(e); }
});

router.post('/jobs/:id/checkout', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await pool.query(
      `UPDATE tbl_job SET checkout_date_time = NOW(), app_checkout_date_time = NOW(),
          fk_checkout_by = ?, job_status = 3, last_update_time = NOW()
        WHERE job_id = ?`,
      [req.tech.efr_id, job.job_id]);
    jobService.fireWebhook('TechVisitComplete', job.job_id);
    modernOk(res, { checkedOut: true });
  } catch (e) { next(e); }
});

router.post('/jobs/:id/reschedule', validate(Joi.object({
  newDate: Joi.date().iso().required(),
  reasonId: Joi.number().integer().positive().required(),
  remarks: Joi.string().max(500).optional(),
})), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await pool.query(
      `UPDATE tbl_job SET requested_date_time = ?, reschedule_reason_id = ?, reschedule_remarks = ?,
          reschedule_at_app = NOW(), is_rescheduled_by_app = 1, resch_job_count = COALESCE(resch_job_count, 0) + 1,
          last_update_time = NOW()
        WHERE job_id = ?`,
      [req.body.newDate, req.body.reasonId, req.body.remarks || null, job.job_id]);
    jobService.fireWebhook('RescheduleTech', job.job_id);
    modernOk(res, { rescheduled: true });
  } catch (e) { next(e); }
});

// Profile sub-tree — covers the legacy /profile/* endpoints
router.get('/profile', async (req, res, next) => {
  try {
    const [[tech]] = await pool.query('SELECT * FROM tbl_easyfixer WHERE efr_id = ?', [req.tech.efr_id]);
    modernOk(res, tech);
  } catch (e) { next(e); }
});

router.get('/profile/percentage', async (req, res, next) => {
  try {
    const [[p]] = await pool.query(
      `SELECT efr_profile_perc, efr_personal_details_perc, efr_professional_details_perc,
              efr_bank_details_perc, efr_identity_details_perc
         FROM tbl_easyfixer WHERE efr_id = ?`, [req.tech.efr_id]);
    modernOk(res, p);
  } catch (e) { next(e); }
});

router.post('/profile/personal-details', async (req, res, next) => {
  try {
    const b = req.body || {};
    await pool.query(
      `UPDATE tbl_easyfixer SET
        efr_marital_status = COALESCE(?, efr_marital_status),
        efr_children = COALESCE(?, efr_children),
        date_of_birth = COALESCE(?, date_of_birth),
        about_yourself = COALESCE(?, about_yourself),
        efr_personal_details_perc = 100
       WHERE efr_id = ?`,
      [b.maritalStatus, b.children, b.dateOfBirth, b.about, req.tech.efr_id]);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.post('/profile/professional-details', async (req, res, next) => {
  try {
    const b = req.body || {};
    await pool.query(
      `UPDATE tbl_easyfixer SET experience_id = COALESCE(?, experience_id), efr_tools = COALESCE(?, efr_tools),
          efr_professional_details_perc = 100 WHERE efr_id = ?`,
      [b.experienceId, b.tools, req.tech.efr_id]);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.post('/profile/identity-details', validate(Joi.object({
  aadhaar: Joi.string().pattern(/^[0-9]{12}$/).optional(),
  pan: Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/i).optional(),
}).min(1)), async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE tbl_easyfixer SET adhaar_card_number = COALESCE(?, adhaar_card_number),
          pan_card_number = COALESCE(?, pan_card_number),
          efr_identity_details_perc = 100 WHERE efr_id = ?`,
      [req.body.aadhaar, req.body.pan, req.tech.efr_id]);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.get('/bank-details', async (req, res, next) => {
  try {
    const [[b]] = await pool.query('SELECT * FROM tbl_easyfixer_bank_details WHERE efr_id = ? LIMIT 1', [req.tech.efr_id]);
    modernOk(res, b || null);
  } catch (e) { next(e); }
});

router.post('/bank-details', async (req, res, next) => {
  try {
    const b = req.body || {};
    const [[existing]] = await pool.query('SELECT efr_bank_id FROM tbl_easyfixer_bank_details WHERE efr_id = ?', [req.tech.efr_id]);
    if (existing) {
      await pool.query(
        `UPDATE tbl_easyfixer_bank_details SET efr_bank_acc_num = ?, efr_bank_ifsc = ?, bank = ?, is_bank_details_filled = 1 WHERE efr_id = ?`,
        [b.accountNumber, b.ifsc, b.bankId || null, req.tech.efr_id]);
    } else {
      await pool.query(
        `INSERT INTO tbl_easyfixer_bank_details (efr_bank_acc_num, efr_bank_ifsc, bank, efr_id, is_bank_details_filled)
         VALUES (?, ?, ?, ?, 1)`,
        [b.accountNumber, b.ifsc, b.bankId || null, req.tech.efr_id]);
    }
    await pool.query('UPDATE tbl_easyfixer SET efr_bank_details_perc = 100 WHERE efr_id = ?', [req.tech.efr_id]);
    modernOk(res, { saved: true });
  } catch (e) { next(e); }
});

router.post('/device', validate(Joi.object({
  deviceId: Joi.string().required(),
  fcmToken: Joi.string().required(),
  appVersion: Joi.string().optional(),
  language: Joi.string().max(10).optional(),
})), async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO device_info (user_id, device_id, fire_base_token, app_version_name, language, is_logged_in, last_login_time)
       VALUES (?, ?, ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE fire_base_token = VALUES(fire_base_token), is_logged_in = 1, last_login_time = NOW()`,
      [req.tech.efr_id, req.body.deviceId, req.body.fcmToken, req.body.appVersion || null, req.body.language || 'en']);
    modernOk(res, { registered: true });
  } catch (e) { next(e); }
});

router.get('/training-videos', async (req, res, next) => {
  try {
    // Real column set unknown; return scaffolded placeholder with TODO
    modernOk(res, { videos: [], note: 'training videos table TBD — Phase 12' });
  } catch (e) { next(e); }
});

// Customer lookup by mobile (from tech app for OTP flows)
router.get('/customers/mobile/:mobile', async (req, res, next) => {
  try {
    const [[cust]] = await pool.query(
      'SELECT customer_id, customer_name, customer_mob_no, customer_email FROM tbl_customer WHERE customer_mob_no = ? LIMIT 1',
      [req.params.mobile]);
    modernOk(res, cust || null);
  } catch (e) { next(e); }
});

module.exports = router;
