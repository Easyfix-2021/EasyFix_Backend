const router = require('express').Router();

const validate = require('../../middleware/validate');
const job = require('../../services/job.service');
const candidateRanking = require('../../services/candidate-ranking.service');
const { modernOk, modernError } = require('../../utils/response');
const {
  listQuery, createBody, updateBody, statusBody, assignBody, ownerBody, idParam,
} = require('../../validators/job.validator');
const { assertEntityInScope } = require('../../lib/scope');

/*
 * Row-level scope guard for every /:id endpoint. Fetches the job once,
 * confirms (client_id, city_id, vertical_id) all sit within the caller's
 * manage_* scope. Returns 404 (not 403) on scope failure to avoid leaking
 * existence of out-of-scope job_ids. Attaches the row at req.scopedJob
 * so downstream handlers can use it without a second fetch.
 */
async function scopedJob(req, res, next) {
  try {
    const j = await job.getById(req.params.id);
    if (!j) return modernError(res, 404, 'job not found');
    const guard = assertEntityInScope(req, {
      client_id:   j.fk_client_id,
      city_id:     j.city_id,
      vertical_id: j.vertical_id,
    });
    if (!guard.ok) return modernError(res, 404, 'job not found');
    req.scopedJob = j;
    return next();
  } catch (e) { next(e); }
}

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
router.get('/:id/candidates', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
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
    // Row-level RBAC + reporting hierarchy: row-filter the list by the
    // UNION of (caller's own manage_* scope) ∪ (every direct/indirect
    // report's manage_* scope). Admin/Finance bypass via the bypass
    // list in lib/scope.js.
    const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
    const { pool } = require('../../db');
    const scope = await buildRequestScopeWithHierarchy(req, pool);
    const { rows, total } = await job.list({ ...req.query, scope });
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
    // Dashboard cards must respect the caller's RBAC scope (hierarchy-
    // unioned). req.scope is attached by the global admin middleware
    // (routes/admin/index.js). Admin/Finance get undefined → no row filter.
    const counts = await job.getStatusCounts({
      ownerId: Number.isFinite(ownerId) ? ownerId : undefined,
      scope: req.scope,
    });
    modernOk(res, counts);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/escalated
 *
 * Ported from legacy ACD action `getEscalatedJobs` (JobDaoImpl.java:4690).
 * Returns the same enriched shape the Angular Client Dashboard's
 * "Escalated Jobs" modal renders.
 *
 * Data sources (verified against legacy SQL):
 *   - tbl_easyfixer_rating_by_customer (alias e)  : the canonical
 *       escalation record. Columns: table_id, job_id, easyfixer_id,
 *       is_escalated (0/1), escalated_by (user_id FK), escalated_time,
 *       resolved_time, escalated_comments, no_of_escalations,
 *       escalated_from, completed_action, inprogress_action,
 *       closed_action, escalation_closed_time.
 *   - tbl_job_escalation_info (alias i)           : per-stage history.
 *       Aggregated into job_stage (CSV of "date + stage") so each row
 *       shows where the job sat at each escalation moment.
 *   - tbl_job (j), tbl_address (a), tbl_city (c), tbl_client (cl),
 *     tbl_user (u) — joined for client name, city, owner, etc.
 *
 * Filter param `status` ∈ {open, closed, pending}:
 *   - open    : escalated_time IS NOT NULL AND
 *               (resolved_time IS NULL OR escalated_time > resolved_time
 *                OR closed_action = 16)
 *   - closed  : escalated_time + resolved_time + escalation_closed_time
 *               all NOT NULL AND closed_action != 16
 *   - pending : escalated > resolved, no closed_action=15
 *
 * RBAC: respects req.scope (clients × cities × verticals).
 */
router.get('/escalated', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'open').toLowerCase();
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const clauses = ['e.is_escalated = 1', 'e.escalated_time IS NOT NULL'];
    const params = [];

    if (status === 'open') {
      clauses.push('(e.resolved_time IS NULL OR e.escalated_time > e.resolved_time OR e.closed_action = 16)');
    } else if (status === 'closed') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalation_closed_time IS NOT NULL');
      clauses.push('(e.closed_action IS NULL OR e.closed_action != 16)');
    } else if (status === 'pending') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalated_time < e.resolved_time');
      clauses.push('(e.escalation_closed_time IS NULL OR e.closed_action != 15)');
    }

    if (q) {
      clauses.push('(j.job_id = ? OR cl.client_name LIKE ? OR c.city_name LIKE ?)');
      params.push(Number(q) || 0, `%${q}%`, `%${q}%`);
    }

    // RBAC scope — same shape as the main list. We only filter when scope
    // is set; Admin/Finance bypass via the lib/scope.js bypass list.
    const sc = req.scope;
    if (sc) {
      if (sc.clients) {
        if (sc.clients.mode === 'none') clauses.push('1=0');
        else if (sc.clients.mode === 'allow' && sc.clients.ids.length) {
          clauses.push(`j.fk_client_id IN (${sc.clients.ids.map(() => '?').join(',')})`);
          params.push(...sc.clients.ids);
        }
      }
      if (sc.cities) {
        if (sc.cities.mode === 'none') clauses.push('1=0');
        else if (sc.cities.mode === 'allow' && sc.cities.ids.length) {
          clauses.push(`a.city_id IN (${sc.cities.ids.map(() => '?').join(',')})`);
          params.push(...sc.cities.ids);
        }
      }
      if (sc.verticals) {
        if (sc.verticals.mode === 'none') clauses.push('1=0');
        else if (sc.verticals.mode === 'allow' && sc.verticals.ids.length) {
          clauses.push(`cl.vertical_id IN (${sc.verticals.ids.map(() => '?').join(',')})`);
          params.push(...sc.verticals.ids);
        }
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // Aggregated job_stage subquery — for each job, concatenates every
    // (escalation_time, job_stage) pair from tbl_job_escalation_info.
    // Mirrors the legacy group_concat in JobDaoImpl line 4705.
    const baseFrom = `
      FROM tbl_easyfixer_rating_by_customer e
      LEFT JOIN tbl_job     j  ON j.job_id = e.job_id
      LEFT JOIN tbl_address a  ON a.address_id = j.fk_address_id
      LEFT JOIN tbl_city    c  ON c.city_id = a.city_id
      LEFT JOIN tbl_client  cl ON cl.client_id = j.fk_client_id
      LEFT JOIN tbl_user    u  ON u.user_id = e.escalated_by
      LEFT JOIN (
        SELECT job_id,
               GROUP_CONCAT(
                 CONCAT(
                   DATE_FORMAT(escalation_time, '%d %M %Y %h:%i %p'),
                   ' · ', COALESCE(job_stage, '—')
                 )
                 ORDER BY escalation_time
                 SEPARATOR ' / '
               ) AS job_stage_history
          FROM tbl_job_escalation_info
         GROUP BY job_id
      ) j1 ON j1.job_id = j.job_id
    `;

    const { pool } = require('../../db');
    const [rows] = await pool.query(
      `SELECT
         e.table_id, e.job_id, j.job_status, j.fk_easyfixter_id,
         e.escalated_time, e.resolved_time, e.escalation_closed_time,
         e.escalated_by, u.user_name AS escalated_by_name,
         e.escalated_comments, e.no_of_escalations, e.escalated_from,
         e.closed_action, e.completed_action, e.inprogress_action,
         j.requested_date_time, j.job_reference_id, j.client_ref_id, j.sub_job_id,
         cl.client_name, c.city_name,
         j1.job_stage_history
       ${baseFrom}
       ${where}
       ORDER BY e.escalated_time DESC, e.table_id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${baseFrom} ${where}`, params
    );
    modernOk(res, { items: rows, total, limit, offset });
  } catch (e) { next(e); }
});

/*
 * PATCH /api/admin/jobs/escalated/:tableId
 *
 * Updates one escalation workflow row (`tbl_easyfixer_rating_by_customer`).
 * Drives the inline Team Action / Completed Action / Closed Action +
 * Comment controls in the EscalatedJobsModal. Allowed fields:
 *
 *   inprogress_action : 1..5 (Team Action enum, legacy values from
 *                       escalateSearchResult.vm:64-71)
 *   completed_action  : 11..12 (Completed Action enum)
 *   closed_action     : 15 (Resolved) | 16 (Re-Open)
 *   escalated_comments: free text appended/replaced (legacy let
 *                       supply team add an inline comment per row)
 *
 * When closed_action transitions to 15 (Resolved), also stamp
 * escalation_closed_time = NOW(). When set to 16 (Re-Open), clear
 * the closed_time so the row goes back to the "open" filter.
 */
router.patch('/escalated/:tableId', async (req, res, next) => {
  try {
    const { pool } = require('../../db');
    const tableId = Number(req.params.tableId);
    if (!Number.isInteger(tableId) || tableId <= 0) {
      return modernError(res, 400, 'invalid tableId');
    }
    const sets = [];
    const params = [];
    const b = req.body || {};

    // Team Action — `inprogress_action` column.
    if (b.inprogress_action !== undefined) {
      const v = Number(b.inprogress_action);
      if (!Number.isInteger(v) || v < 0 || v > 5) {
        return modernError(res, 400, 'inprogress_action must be 0..5');
      }
      sets.push('inprogress_action = ?');
      params.push(v || null);
    }
    // Completed Action.
    if (b.completed_action !== undefined) {
      const v = Number(b.completed_action);
      if (!Number.isInteger(v) || (v !== 0 && v !== 11 && v !== 12)) {
        return modernError(res, 400, 'completed_action must be 11 or 12');
      }
      sets.push('completed_action = ?');
      params.push(v || null);
    }
    // Closed Action — also stamps / clears escalation_closed_time.
    if (b.closed_action !== undefined) {
      const v = Number(b.closed_action);
      if (!Number.isInteger(v) || (v !== 0 && v !== 15 && v !== 16)) {
        return modernError(res, 400, 'closed_action must be 15 (Resolved) or 16 (Re-Open)');
      }
      sets.push('closed_action = ?');
      params.push(v || null);
      if (v === 15) {
        sets.push('escalation_closed_time = NOW()');
        // also mark resolved_time so the "closed" filter picks it up
        sets.push('resolved_time = COALESCE(resolved_time, NOW())');
      } else if (v === 16) {
        // Re-Open: clear closed_time + bump no_of_escalations so the
        // row falls back into the "open" filter. Legacy did the same.
        sets.push('escalation_closed_time = NULL');
        sets.push('no_of_escalations = COALESCE(no_of_escalations, 0) + 1');
        sets.push('escalated_time = NOW()');
      }
    }
    if (b.escalated_comments !== undefined) {
      const txt = String(b.escalated_comments || '').slice(0, 2000);
      sets.push('escalated_comments = ?');
      params.push(txt || null);
    }
    if (sets.length === 0) {
      return modernError(res, 400, 'no editable fields supplied');
    }
    params.push(tableId);
    const [r] = await pool.query(
      `UPDATE tbl_easyfixer_rating_by_customer SET ${sets.join(', ')} WHERE table_id = ?`,
      params
    );
    if (r.affectedRows === 0) {
      return modernError(res, 404, 'escalation row not found');
    }
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), scopedJob, async (req, res) => {
  modernOk(res, req.scopedJob);
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    // Scope check on create: caller can only create jobs for a client/city
    // within their manage_* scope. Same guard runs on subsequent edits via
    // the `scopedJob` middleware.
    const guard = assertEntityInScope(req, {
      client_id: req.body.fk_client_id,
      city_id:   req.body.address?.city_id,
    });
    if (!guard.ok) return modernError(res, 403, 'cannot create a job outside your assigned scope');
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
router.put('/:id',   validate(idParam, 'params'), validate(updateBody), scopedJob, updateHandler);
router.patch('/:id', validate(idParam, 'params'), validate(updateBody), scopedJob, updateHandler);

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), scopedJob, async (req, res, next) => {
  try {
    const updated = await job.setStatus(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job status updated');
  } catch (e) { next(e); }
});

router.patch('/:id/assign', validate(idParam, 'params'), validate(assignBody), scopedJob, async (req, res, next) => {
  try {
    const updated = await job.assign(req.params.id, req.body, req.user);
    modernOk(res, updated, 'technician assigned');
  } catch (e) { next(e); }
});

router.patch('/:id/owner', validate(idParam, 'params'), validate(ownerBody), scopedJob, async (req, res, next) => {
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
router.put('/:id/hold', validate(idParam, 'params'), validate(holdBody), scopedJob, async (req, res, next) => {
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
router.post('/:id/hold/release', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
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
router.get('/:id/estimate/preview', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
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
  scopedJob,
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

router.get('/:id/comments', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try { modernOk(res, await jobComments.listComments(req.params.id)); }
  catch (e) { next(e); }
});

router.post('/:id/comments',
  validate(idParam, 'params'),
  validate(commentBody),
  scopedJob,
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

router.get('/:id/feedback', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try { modernOk(res, await jobFeedback.getFeedback(req.params.id)); }
  catch (e) { next(e); }
});

router.put('/:id/feedback',
  validate(idParam, 'params'),
  validate(feedbackBody),
  scopedJob,
  async (req, res, next) => {
    try {
      const row = await jobFeedback.upsertFeedback(Number(req.params.id), req.body);
      modernOk(res, row, 'Feedback saved');
    } catch (e) { next(e); }
  }
);

module.exports = router;
