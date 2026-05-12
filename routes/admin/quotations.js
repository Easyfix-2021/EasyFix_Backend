const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

/*
 * Quotations admin CRUD + validator + expiry countdown.
 *
 * VERIFIED 2026-05-12 against ACD_APIs QuotationDetails.java:
 *   quotation_details columns:
 *     id (PK), type, name, unit, unit_price,
 *     tx_charge, client_charge, approved_charge, margin,
 *     status (bool), easyfxer_id  (LEGACY TYPO — preserve "easyfxer"),
 *     action_by, sent_by, sent_on, action_on,
 *     job_id, client_service_id, material_id, job_service_id
 *
 * NOTE: Earlier iteration shipped this file with WRONG columns
 * (quotation_type, description, quantity, total_price, created_by,
 * created_date). Bug fixed 2026-05-12 — replaced with verified names.
 */

router.get('/', async (req, res, next) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return modernError(res, 400, 'jobId required');
    const [rows] = await pool.query(
      `SELECT id, type, name, unit, unit_price,
              tx_charge, client_charge, approved_charge, margin,
              status, easyfxer_id, action_by, sent_by, sent_on, action_on,
              job_id, client_service_id, material_id, job_service_id
         FROM quotation_details
        WHERE job_id = ?
        ORDER BY id DESC`,
      [jobId]
    );
    modernOk(res, rows);
  } catch (e) { next(e); }
});

const productBody = Joi.object({
  jobId: Joi.number().integer().positive().required(),
  name: Joi.string().trim().min(1).max(255).required(),
  unit: Joi.number().integer().min(1).default(1),
  unitPrice: Joi.number().min(0).default(0),
  clientCharge: Joi.number().min(0).optional(),
  txCharge: Joi.number().min(0).optional(),
  margin: Joi.number().min(0).optional(),
  clientServiceId: Joi.number().integer().positive().optional(),
  jobServiceId: Joi.number().integer().positive().optional(),
});

router.post('/product', validate(productBody), async (req, res, next) => {
  try {
    const [ins] = await pool.query(
      `INSERT INTO quotation_details
         (type, name, unit, unit_price, tx_charge, client_charge, margin,
          status, sent_by, sent_on, job_id, client_service_id, job_service_id)
       VALUES ('product', ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, ?, ?)`,
      [
        req.body.name, req.body.unit, req.body.unitPrice,
        req.body.txCharge || 0, req.body.clientCharge || 0,
        req.body.margin || 0, req.user.user_id,
        req.body.jobId,
        req.body.clientServiceId || null,
        req.body.jobServiceId || null,
      ]
    );
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

router.post('/material', validate(productBody.fork(['name'], (s) => s)
    .keys({ materialId: Joi.number().integer().positive().optional() })), async (req, res, next) => {
  try {
    const [ins] = await pool.query(
      `INSERT INTO quotation_details
         (type, name, unit, unit_price, tx_charge, client_charge, margin,
          status, sent_by, sent_on, job_id, material_id, job_service_id)
       VALUES ('material', ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, ?, ?)`,
      [
        req.body.name, req.body.unit, req.body.unitPrice,
        req.body.txCharge || 0, req.body.clientCharge || 0,
        req.body.margin || 0, req.user.user_id,
        req.body.jobId,
        req.body.materialId || null,
        req.body.jobServiceId || null,
      ]
    );
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

// SPOC approval / rejection — sets approved_charge and action_*
router.patch('/:id/approve', validate(Joi.object({
  approvedCharge: Joi.number().min(0).required(),
})), async (req, res, next) => {
  try {
    const [r] = await pool.query(
      `UPDATE quotation_details
          SET approved_charge = ?, action_by = ?, action_on = NOW(), status = 1
        WHERE id = ?`,
      [req.body.approvedCharge, req.user.user_id, req.params.id]
    );
    if (r.affectedRows === 0) return modernError(res, 404, 'quotation not found');
    modernOk(res, { approved: true });
  } catch (e) { next(e); }
});

router.patch('/:id/reject', async (req, res, next) => {
  try {
    const [r] = await pool.query(
      `UPDATE quotation_details
          SET status = 0, action_by = ?, action_on = NOW()
        WHERE id = ?`,
      [req.user.user_id, req.params.id]
    );
    if (r.affectedRows === 0) return modernError(res, 404, 'quotation not found');
    modernOk(res, { rejected: true });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM quotation_details WHERE id = ?', [req.params.id]);
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

// ─── Rate-card tolerance validator ──────────────────────────────────
// Real check: for each product quotation line that links to a
// client_service_id, compare unit_price against the linked rate-card's
// total_amount. Flag rows where the quoted price is OUTSIDE a ±25%
// tolerance band (configurable per call).
//
// VERIFIED tbl_client_service.total_amount + crc_id linkage from
// ClientDaoImpl.java:498-504 (see also routes/admin/rate-cards.js).
router.post('/validate', validate(Joi.object({
  jobId: Joi.number().integer().positive().required(),
  tolerancePct: Joi.number().min(0).max(100).default(25),
})), async (req, res, next) => {
  try {
    const { jobId, tolerancePct } = req.body;
    const [rows] = await pool.query(
      `SELECT q.id, q.type, q.name, q.unit, q.unit_price, q.client_charge,
              q.client_service_id,
              cs.total_amount AS rate_card_total
         FROM quotation_details q
         LEFT JOIN tbl_client_service cs ON cs.client_service_id = q.client_service_id
        WHERE q.job_id = ?`,
      [jobId]
    );
    const flagged = [];
    for (const r of rows) {
      if (r.client_service_id && r.rate_card_total != null) {
        const expected = Number(r.rate_card_total);
        const actual = Number(r.unit_price || 0);
        const diffPct = expected > 0 ? Math.abs(actual - expected) / expected * 100 : 0;
        if (diffPct > tolerancePct) {
          flagged.push({
            id: r.id, name: r.name, expected, actual,
            deviation_pct: Number(diffPct.toFixed(1)),
            reason: actual > expected
              ? `quoted ${diffPct.toFixed(1)}% above rate-card`
              : `quoted ${diffPct.toFixed(1)}% below rate-card`,
          });
        }
      } else if (r.unit_price != null && r.unit_price > 50000) {
        flagged.push({
          id: r.id, name: r.name, actual: r.unit_price,
          reason: 'unusually large unit price; no rate-card to compare',
        });
      }
    }
    modernOk(res, {
      total: rows.length,
      flaggedCount: flagged.length,
      tolerancePct,
      flagged,
    });
  } catch (e) { next(e); }
});

// ─── Recce checklist (structured recce per category) ────────────────
// Order Lifecycle §13 calls for per-category mandatory-field checklists
// during the recce (pre-quote site survey) stage. There's no legacy
// table for this — the new app introduces a thin wrapper around
// tbl_questionaire_details (already category-scoped via c_qd_category).
router.get('/recce-checklist/:serviceCatgId', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT qd.c_qd_id, qd.c_qd_text, qd.c_qd_mandatory, qd.c_qd_type,
              qd.c_qd_values, qd.c_qd_category, qd.c_qd_seq
         FROM tbl_questionaire_details qd
         INNER JOIN tbl_questionaire q ON q.c_questionaire_id = qd.c_questionaire_id
        WHERE q.status = 1 AND qd.status = 1
          AND qd.c_qd_category = ?
        ORDER BY qd.c_qd_seq, qd.c_qd_id`,
      [String(req.params.serviceCatgId)]
    );
    modernOk(res, rows);
  } catch (e) { next(e); }
});

// ─── Estimate expiry countdown ──────────────────────────────────────
// Legacy quoted the rule as: "if approval not received within 48h of
// estimate sent, auto-escalate". The send-time is `tbl_job.approval_sent_on_date_time`.
//
// VERIFIED tbl_job columns (JobDaoImpl.java:617):
//   approval_sent_on_date_time, approved_on_date_time,
//   approval_reject_date_time, no_of_req_approval
//
// Returns expiry status for one job; the auto-escalation cron worker
// (Phase 6 notification orchestrator) consumes a list view.
router.get('/expiry/:jobId', async (req, res, next) => {
  try {
    const [[j]] = await pool.query(
      `SELECT job_id, approval_sent_on_date_time, approved_on_date_time,
              approval_reject_date_time, no_of_req_approval
         FROM tbl_job WHERE job_id = ?`,
      [req.params.jobId]
    );
    if (!j) return modernError(res, 404, 'job not found');

    const sent = j.approval_sent_on_date_time ? new Date(j.approval_sent_on_date_time) : null;
    const responded = j.approved_on_date_time || j.approval_reject_date_time;
    const EXPIRY_HOURS = 48;
    let status = 'not_sent';
    let hoursElapsed = null;
    let hoursRemaining = null;
    if (responded) status = 'responded';
    else if (sent) {
      hoursElapsed = (Date.now() - sent.getTime()) / 36e5;
      hoursRemaining = Math.max(0, EXPIRY_HOURS - hoursElapsed);
      status = hoursElapsed > EXPIRY_HOURS ? 'expired' : 'awaiting';
    }
    modernOk(res, {
      job_id: j.job_id,
      status,
      sent_at: sent,
      hours_elapsed: hoursElapsed != null ? Number(hoursElapsed.toFixed(2)) : null,
      hours_remaining: hoursRemaining != null ? Number(hoursRemaining.toFixed(2)) : null,
      attempts: j.no_of_req_approval,
    });
  } catch (e) { next(e); }
});

// List all expired pending estimates — drives the escalation queue.
router.get('/expired', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT j.job_id, j.job_reference_id, j.fk_client_id, c.client_name,
              j.approval_sent_on_date_time, j.no_of_req_approval,
              TIMESTAMPDIFF(HOUR, j.approval_sent_on_date_time, NOW()) AS hours_elapsed
         FROM tbl_job j
         LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id
        WHERE j.approval_sent_on_date_time IS NOT NULL
          AND j.approved_on_date_time IS NULL
          AND j.approval_reject_date_time IS NULL
          AND TIMESTAMPDIFF(HOUR, j.approval_sent_on_date_time, NOW()) > 48
        ORDER BY j.approval_sent_on_date_time
        LIMIT 500`
    );
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
