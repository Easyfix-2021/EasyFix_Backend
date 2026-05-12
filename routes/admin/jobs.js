const router = require('express').Router();

const validate = require('../../middleware/validate');
const job = require('../../services/job.service');
const candidateRanking = require('../../services/candidate-ranking.service');
const { modernOk, modernError } = require('../../utils/response');
const {
  listQuery, createBody, updateBody, statusBody, assignBody, ownerBody, idParam,
} = require('../../validators/job.validator');

// Upload sub-router (POST /upload) — isolated because of multer middleware.
router.use(require('./jobs-upload'));

/*
 * GET /api/admin/jobs/:id/candidates?limit=50
 *
 * Returns ranked technicians for the Assign / Reassign modal on /my-orders
 * and /jobs. Same layered pipeline used by on-create auto-assign — see
 * services/candidate-ranking.service.js. Returns per-candidate breakdowns
 * (Rating, TAT, SDA, Worked-for-Client, Worked-for-Vertical, Attendance)
 * plus account balance for sorting tie-break.
 *
 * If no technician passes the deep-skill filter, the response includes
 * `note: 'no_deep_skill_match'` and the candidates list is the same query
 * with the skill predicate dropped — so the modal can show a banner and
 * still let ops pick someone.
 *
 * Listed BEFORE `/:id/assign` and other `/:id/*` so Express matches the
 * literal `candidates` segment first.
 */
router.get('/:id/candidates', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const result = await candidateRanking.rankCandidatesForJob(req.params.id, { limit });
    modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { rows, total } = await job.list(req.query);
    modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/counts
 * Returns status-bucket totals + grand total in ONE query. Replaces the
 * dashboard's 6 parallel list-with-limit-1 calls (which each spent 2 DB
 * connections on COUNT + data queries — ~12 concurrent connections just for
 * stats, enough to saturate a 20-connection pool when combined with /auth/me
 * and recent-jobs on the same page load). Single GROUP BY = 1 connection.
 */
/*
 * Accepts optional `?ownerId=<user_id>` to scope the buckets to jobs owned
 * by that user (drives the "My Orders" sidebar flow on the CRM). Invalid or
 * missing ownerId falls through to org-wide counts — same response shape,
 * different WHERE clause. Frontend passes `ownerId = currentUser.user_id`
 * when it detects `?scope=mine` on the URL.
 */
router.get('/counts', async (req, res, next) => {
  try {
    const ownerId = req.query.ownerId ? Number(req.query.ownerId) : undefined;
    const counts = await job.getStatusCounts({ ownerId: Number.isFinite(ownerId) ? ownerId : undefined });
    modernOk(res, counts);
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await job.getById(req.params.id);
    if (!row) return modernError(res, 404, 'job not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const created = await job.create(req.body, req.user);
    res.status(201);
    modernOk(res, created, 'job created');
  } catch (e) { next(e); }
});

/*
 * Update — exposed as BOTH PUT and PATCH to the same handler. The CRM_UI
 * edit flow uses PATCH semantically (partial update) while some integration
 * callers use PUT; both land on the same validator + service call so we
 * don't fork behaviour.
 */
const updateHandler = async (req, res, next) => {
  try {
    const updated = await job.update(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job updated');
  } catch (e) { next(e); }
};
router.put('/:id',   validate(idParam, 'params'), validate(updateBody), updateHandler);
router.patch('/:id', validate(idParam, 'params'), validate(updateBody), updateHandler);

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  try {
    const updated = await job.setStatus(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job status updated');
  } catch (e) { next(e); }
});

router.patch('/:id/assign', validate(idParam, 'params'), validate(assignBody), async (req, res, next) => {
  try {
    const updated = await job.assign(req.params.id, req.body, req.user);
    modernOk(res, updated, 'technician assigned');
  } catch (e) { next(e); }
});

router.patch('/:id/owner', validate(idParam, 'params'), validate(ownerBody), async (req, res, next) => {
  try {
    const updated = await job.changeOwner(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job owner changed');
  } catch (e) { next(e); }
});

// ─── Fulfillment hold ───────────────────────────────────────────────
// Mirrors legacy `addEditFullFillmentHold` + `confirmFullfillmentHold`.
//
// VERIFIED tbl_job columns (JobDaoImpl.java:4587):
//   full_fillment_reason, full_fillment_time, full_fillment_by,
//   full_fillment_created_time, no_of_req_foh, job_status
//
// State machine:
//   PUT  /jobs/:id/hold     → job_status = 21, stamp hold fields,
//                              increment no_of_req_foh
//   POST /jobs/:id/hold/release → job_status = 10 (REVISIT)
const { pool } = require('../../db');
const holdBody = require('joi').object({
  reason: require('joi').string().trim().min(1).max(500).required(),
  appointment_time: require('joi').date().iso().required(),
});
router.put('/:id/hold', validate(idParam, 'params'), validate(holdBody), async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE tbl_job
          SET job_status = 21,
              full_fillment_reason = ?,
              full_fillment_time = ?,
              full_fillment_by = ?,
              full_fillment_created_time = NOW(),
              no_of_req_foh = COALESCE(no_of_req_foh, 0) + 1
        WHERE job_id = ?`,
      [req.body.reason, req.body.appointment_time, req.user.user_id, req.params.id]
    );
    modernOk(res, { on_hold: true, status: 21 });
  } catch (e) { next(e); }
});
router.post('/:id/hold/release', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await pool.query('UPDATE tbl_job SET job_status = 10 WHERE job_id = ?', [req.params.id]);
    modernOk(res, { released: true, status: 10 });
  } catch (e) { next(e); }
});

// ─── Multi-step estimate approval workflow ──────────────────────────
// Mirrors legacy JobAction.java `requestApproval` (preview) +
// `confirmApprovejob` (send-for-approval) pair.
//
// VERIFIED tbl_job columns (JobDaoImpl.java:2473 + 4587):
//   approve_job_doc, approval_sent_on_date_time, no_of_req_approval
//
// Two steps:
//   GET  /admin/jobs/:id/estimate/preview         — service breakdown + grand total
//   POST /admin/jobs/:id/estimate/send-for-approval — stamp approval_sent_on_date_time,
//                                                     job_status = 15, increment counter,
//                                                     email PDF to client SPOC
//
// PDF generation reuses `utils/pdf-invoice.js` rendering style but
// produces an estimate-approval doc. For now we send a plain-text
// email with the estimate breakdown; PDF attachment can be wired
// when ops requests it (the SP and audit trail are already in place).
const emailServiceForJobs = require('../../services/email.service');
router.get('/:id/estimate/preview', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    const [services] = await pool.query(
      `SELECT js.job_service_id, js.quantity, js.total_charge, js.material_charge,
              CR.crc_ratecard_name AS service_name
         FROM tbl_job_services js
         LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
         LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
        WHERE js.job_id = ? AND js.job_service_status = 1
        ORDER BY js.job_service_id`,
      [jobId]
    );
    const lines = services.map((s) => ({
      ...s,
      line_total: Number(s.total_charge || 0) * Number(s.quantity || 1) + Number(s.material_charge || 0),
    }));
    const grand_total = lines.reduce((sum, l) => sum + l.line_total, 0);
    modernOk(res, { job_id: jobId, services: lines, grand_total });
  } catch (e) { next(e); }
});

router.post('/:id/estimate/send-for-approval',
  validate(idParam, 'params'),
  validate(require('joi').object({
    comments: require('joi').string().max(1000).allow('', null).optional(),
  }).optional()),
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Stamp tbl_job — mirrors legacy `JobApproveDetails` second UPDATE.
        await conn.query(
          `UPDATE tbl_job
              SET job_status = 15,
                  approval_sent_on_date_time = NOW(),
                  no_of_req_approval = COALESCE(no_of_req_approval, 0) + 1
            WHERE job_id = ?`,
          [jobId]
        );
        await conn.commit();
      } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }

      // Fire email asynchronously — failure shouldn't roll back the
      // state transition. Reporting contact email lives on tbl_client_contacts.
      sendEstimateEmail(jobId, req.user.user_id).catch(() => {});
      modernOk(res, { sent: true, status: 15 });
    } catch (e) { next(e); }
  }
);

async function sendEstimateEmail(jobId, userId) {
  const [[j]] = await pool.query(
    `SELECT j.job_id, j.job_reference_id, j.client_ref_id, j.reporting_contact_id,
            j.client_spoc_email, j.fk_client_id,
            cl.client_name, cu.customer_name, cu.customer_mob_no,
            u.official_email AS owner_email
       FROM tbl_job j
       LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_user      u ON u.user_id      = j.job_owner
      WHERE j.job_id = ? LIMIT 1`,
    [jobId]
  );
  if (!j) return;
  const [services] = await pool.query(
    `SELECT js.quantity, js.total_charge, js.material_charge,
            CR.crc_ratecard_name AS service_name
       FROM tbl_job_services js
       LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
       LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
      WHERE js.job_id = ? AND js.job_service_status = 1`,
    [jobId]
  );

  const total = services.reduce((s, x) => s + Number(x.total_charge || 0) * Number(x.quantity || 1) + Number(x.material_charge || 0), 0);
  const lineBlock = services
    .map((s) => `  ${s.service_name || '—'} × ${s.quantity}  =  ${(Number(s.total_charge || 0) * Number(s.quantity || 1) + Number(s.material_charge || 0)).toFixed(2)}`)
    .join('\n');

  // Recipient resolution mirrors legacy `confirmApprovejob`:
  // reporting contact's manager_name CSV (legacy stores emails here, not
  // names) + contact_email, owner email. Skip clearly malformed entries
  // so a typo in one CSV field doesn't poison the whole send.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const recipients = new Set();
  const skipped = [];
  const addIfValid = (raw, source) => {
    const v = String(raw || '').trim();
    if (!v) return;
    if (EMAIL_RE.test(v)) recipients.add(v);
    else skipped.push({ value: v, source });
  };
  addIfValid(j.client_spoc_email, 'job.client_spoc_email');
  addIfValid(j.owner_email,       'owner.official_email');
  if (j.reporting_contact_id) {
    const [[c]] = await pool.query(
      'SELECT contact_email, manager_name FROM tbl_client_contacts WHERE id = ?',
      [j.reporting_contact_id]
    );
    if (c) {
      addIfValid(c.contact_email, 'contact.contact_email');
      if (c.manager_name) {
        for (const m of String(c.manager_name).split(',')) {
          addIfValid(m, 'contact.manager_name[]');
        }
      }
    }
  }
  if (recipients.size === 0) {
    require('../../logger').warn(
      `Estimate email skipped — no valid recipients for job ${jobId}` +
      (skipped.length ? ` (rejected ${skipped.length} malformed entries)` : '')
    );
    return;
  }

  await emailServiceForJobs.send({
    to: [...recipients],
    subject: `Client_Estimate Approval_${j.job_id}_${j.customer_name || ''}_${j.customer_mob_no || ''}`,
    text: `Hi ${j.client_name || ''},\n\n`
      + `Please find below the estimate for job ${j.job_reference_id || j.job_id}.\n\n`
      + `Services:\n${lineBlock}\n\n`
      + `Grand total: ${total.toFixed(2)}\n\n`
      + `Kindly approve via the client portal.\n\nRegards,\nEasyFix`,
    category: 'estimate.send-for-approval',
  });
}

// ─── Job Comments sub-resource (legacy tbl_job_comment) ──────────────
const jobComments = require('../../services/job-comment.service');
const Joi = require('joi');
const commentBody = Joi.object({
  comments:       Joi.string().trim().min(1).max(2000).required(),
  comment_on:     Joi.number().integer().valid(1, 2, 3, 4).required(),
  appointment_on: Joi.date().iso().optional(),
  enum_reason_id: Joi.number().integer().positive().optional(),
  efr_id:         Joi.number().integer().positive().optional(),
});

router.get('/:id/comments', validate(idParam, 'params'), async (req, res, next) => {
  try { modernOk(res, await jobComments.listComments(req.params.id)); }
  catch (e) { next(e); }
});

router.post('/:id/comments',
  validate(idParam, 'params'),
  validate(commentBody),
  async (req, res, next) => {
    try {
      const created = await jobComments.addComment(req.params.id, {
        ...req.body,
        commented_by: req.user?.user_id,
      });
      res.status(201);
      modernOk(res, created, 'Comment added');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

// ─── Job Feedback sub-resource (legacy tbl_customer_feedback) ─────────
const jobFeedback = require('../../services/job-feedback.service');
// VERIFIED against tbl_customer_feedback (see services/job-feedback.service.js).
// Legacy columns: easyfixer_rating, easyfix_rating, happy_with_service.
// `happyWithService` is a tinyint (0/1) per legacy convention.
const feedbackBody = Joi.object({
  easyfixerRating:   Joi.number().min(1).max(5).optional(),
  easyfixRating:     Joi.number().min(1).max(5).optional(),
  happyWithService:  Joi.number().integer().valid(0, 1).optional(),
}).min(1);

router.get('/:id/feedback', validate(idParam, 'params'), async (req, res, next) => {
  try { modernOk(res, await jobFeedback.getFeedback(req.params.id)); }
  catch (e) { next(e); }
});

router.put('/:id/feedback',
  validate(idParam, 'params'),
  validate(feedbackBody),
  async (req, res, next) => {
    try {
      const row = await jobFeedback.upsertFeedback(Number(req.params.id), req.body);
      modernOk(res, row, 'Feedback saved');
    } catch (e) { next(e); }
  }
);

module.exports = router;
