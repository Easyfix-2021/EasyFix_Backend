const router = require('express').Router();
const { pool } = require('../../db');
const logger = require('../../logger');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const kaleyra = require('../../services/kaleyra.service');
const { getEffectivePermissions } = require('../../services/role.service');
const { clickToCallBody, callListQuery } = require('../../validators/calls.validator');

/*
 * /api/admin/calls — operator-driven outbound calls + call history.
 *
 * Endpoints:
 *   POST /click-to-call  → places an outbound Kaleyra call from the
 *                          operator's own mobile to the customer of a
 *                          job (or a customer directly). Permission-
 *                          gated by `isClickToCall`.
 *   GET  /               → paginated call history for the navbar's
 *                          Call Info modal. Joins agent/customer names +
 *                          job ref onto the raw tbl_job_caller_info row.
 *
 * Auth + role(['admin']) come from the parent router (routes/admin/index.js).
 */

/*
 * Permission gate middleware. Mirrors routes/admin/quicksight.js's pattern.
 * We don't pre-cache the permission list on req.user — getEffectivePermissions
 * has its own role/menu cache, so this is cheap.
 */
async function requireClickToCallAction(req, res, next) {
  try {
    const perms = await getEffectivePermissions(req.user.user_id);
    if (!perms.actionPermissions.includes('isClickToCall')) {
      return modernError(res, 403, 'You do not have permission to place outbound calls');
    }
    return next();
  } catch (e) { return next(e); }
}

// ─── POST /click-to-call ─────────────────────────────────────────────
router.post('/click-to-call', requireClickToCallAction, validate(clickToCallBody), async (req, res, next) => {
  try {
    const { jobId, customerId } = req.body;
    const agent = req.user;

    // Agent mobile guard — operator must have filled in their profile.
    if (!agent.mobile_no || String(agent.mobile_no).replace(/\D/g, '').length < 10) {
      return modernError(res, 400, 'Your profile does not have a valid mobile number. Update your profile before placing calls.');
    }

    // ── Resolve receiver mobile + name + (optional) job context ──
    // FE never sends the mobile — we always look it up server-side.
    let receiverMobile;
    let receiverName;
    let receiverCustomerId = null;
    let jobIdToStore       = null;
    let jobStatusSnapshot  = null;
    let jobEfrId           = null;

    if (jobId) {
      // Customer mobile lives ONLY on tbl_customer; tbl_job does not have a
      // mobile column. tbl_job DOES carry an optional job_customer_name
      // override (set during bulk uploads), which we honour over the
      // canonical tbl_customer.customer_name when present — same precedence
      // the JobModal display uses.
      const [[job]] = await pool.query(
        `SELECT j.job_id, j.fk_customer_id, j.fk_easyfixter_id, j.job_status,
                COALESCE(j.job_customer_name, c.customer_name) AS customer_name,
                c.customer_mob_no
           FROM tbl_job j
      LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
          WHERE j.job_id = ?
          LIMIT 1`,
        [jobId]
      );
      if (!job) return modernError(res, 404, `Job ${jobId} not found`);
      if (!job.customer_mob_no) return modernError(res, 400, `Job ${jobId} has no customer mobile on file`);
      receiverMobile      = job.customer_mob_no;
      receiverName        = job.customer_name || null;
      receiverCustomerId  = job.fk_customer_id || null;
      jobIdToStore        = job.job_id;
      jobStatusSnapshot   = job.job_status;
      jobEfrId            = job.fk_easyfixter_id || null;
    } else {
      // customerId path — customer-only call, no associated job row
      const [[cust]] = await pool.query(
        `SELECT customer_id, customer_name, customer_mob_no
           FROM tbl_customer WHERE customer_id = ? LIMIT 1`,
        [customerId]
      );
      if (!cust) return modernError(res, 404, `Customer ${customerId} not found`);
      if (!cust.customer_mob_no) return modernError(res, 400, `Customer ${customerId} has no mobile on file`);
      receiverMobile     = cust.customer_mob_no;
      receiverName       = cust.customer_name || null;
      receiverCustomerId = cust.customer_id;
    }

    // ── Place the Kaleyra call ──
    const callResult = await kaleyra.clickToCall({
      from: agent.mobile_no,
      to:   receiverMobile,
    });

    if (!callResult.delivered) {
      // Suppressed-mode dev convenience: still return 200 so the UI can
      // show "would have called" feedback. Distinct from real failures,
      // which bubble as 4xx/5xx below.
      if (callResult.suppressed || callResult.disabled) {
        return modernOk(res, {
          delivered: false,
          suppressed: true,
          message: 'Outbound calling is disabled in this environment (set KALEYRA_CALLING_ENABLED=true to enable).',
        });
      }

      // Hand the FE the EXACT reason so the toast is actionable. The
      // service layer already classified the failure via the
      // `diagnostic` field so we don't have to re-parse strings here.
      //   - caller_equals_receiver  → 400 (config issue, caller can fix
      //                                    by changing TEST_MOBILE)
      //   - kaleyra_soft_fail_no_id → 502 (provider accepted HTTP but
      //                                    didn't dispatch a call leg)
      //   - kaleyra_http_error      → 502 (provider returned non-2xx)
      //   - network_error           → 502 (couldn't reach Kaleyra)
      const status = callResult.diagnostic === 'caller_equals_receiver' ? 400 : 502;
      const baseMsg = callResult.error
        || callResult.providerError
        || `Kaleyra rejected the call${callResult.providerStatus ? ` (status=${callResult.providerStatus})` : ''}`;
      return modernError(res, status, baseMsg, {
        diagnostic: callResult.diagnostic,
        providerStatus: callResult.providerStatus,
        providerError: callResult.providerError,
      });
    }

    // ── Persist to tbl_job_caller_info ──
    // Column-name typos `reciever*` preserved verbatim per backend CLAUDE.md.
    // is_updated=0 → flagged for the cron to fill in metadata.
    const [insertResult] = await pool.query(
      `INSERT INTO tbl_job_caller_info
         (job_id, unique_id, caller, caller_id, caller_name,
          reciever, reciever_id, reciever_name,
          job_status, job_efr_id, call_type, inserted_by, is_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OUT', ?, 0)`,
      [
        jobIdToStore,
        callResult.callId || null,
        kaleyra.normaliseIndianPhone(agent.mobile_no),
        agent.user_id,
        agent.user_name,
        kaleyra.normaliseIndianPhone(receiverMobile),
        receiverCustomerId,
        receiverName,
        jobStatusSnapshot,
        jobEfrId,
        agent.user_id,
      ]
    );

    logger.info(`Click-to-call placed · agent=${agent.user_name}(#${agent.user_id}) → ${receiverName || receiverCustomerId || 'customer'} · row=${insertResult.insertId} · uniqueId=${callResult.callId || '—'}`);
    return modernOk(res, {
      delivered: true,
      jobCallerInfoId: insertResult.insertId,
      callId: callResult.callId || null,
      // `overridden` is the new field — true when either KALEYRA_CALL_FROM
      // or KALEYRA_CALL_TO substituted a leg. Kept the `redirected` alias
      // so any FE that hadn't been updated yet still reads truthy.
      overridden: callResult.overridden || false,
      redirected: callResult.overridden || false,
      message: callResult.overridden
        ? 'Dev override active — one or both legs routed to a KALEYRA_CALL_* test number instead of the real participant.'
        : 'Calling — your phone will ring shortly.',
    });
  } catch (e) { next(e); }
});

// ─── GET / — paginated call history ───────────────────────────────────
router.get('/', validate(callListQuery, 'query'), async (req, res, next) => {
  try {
    const { jobId, customerId, dateFrom, dateTo, page, limit } = req.query;
    const where = [];
    const params = [];
    if (jobId)      { where.push('jci.job_id = ?');      params.push(jobId); }
    if (customerId) { where.push('jci.reciever_id = ?'); params.push(customerId); }
    if (dateFrom)   { where.push('jci.inserted_time >= ?'); params.push(dateFrom); }
    if (dateTo)     { where.push('jci.inserted_time < ?');  params.push(dateTo); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tbl_job_caller_info jci ${whereSql}`,
      params
    );
    const [rows] = await pool.query(
      `SELECT jci.job_caller_info AS id,
              jci.job_id,
              jci.unique_id,
              jci.caller,
              jci.caller_id,
              jci.caller_name,
              jci.reciever      AS receiver,
              jci.reciever_id   AS receiver_id,
              jci.reciever_name AS receiver_name,
              jci.call_type,
              jci.start_time,
              jci.end_time,
              jci.duration,
              jci.caller_status,
              jci.reciever_status AS receiver_status,
              jci.recording,
              jci.location,
              jci.provider,
              jci.inserted_time,
              jci.is_updated
         FROM tbl_job_caller_info jci
         ${whereSql}
         ORDER BY jci.inserted_time DESC
         LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return modernOk(res, { total, page, limit, items: rows });
  } catch (e) { next(e); }
});

module.exports = router;
