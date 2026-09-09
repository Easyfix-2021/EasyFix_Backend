const { pool } = require('../db');
const { calculateCharges } = require('./client-rate-cards.service');

/*
 * Per-service charge breakdown for one job — the L1–L4 rate-card cascade
 * applied to every active tbl_job_services row.
 *
 * WHY THIS IS A SERVICE AND NOT A ROUTE BODY (2026-09-09)
 *
 * It was inline in GET /admin/jobs/:id/service-breakdown, which made it
 * reachable by exactly one caller. The CRM's Billing & Charges tab needed the
 * same numbers and could not have them, so it rendered the Services row as
 * `{ client: Σ js.total_charge, tx: 0 }` — a hardcoded zero with a comment
 * admitting the assumption. The Services tab of the SAME modal, meanwhile, was
 * showing a real per-service technician charge from this cascade. One modal,
 * two tabs, two answers.
 *
 * WHY NOT THE STORED COLUMNS. tbl_job_services carries client_charge /
 * easyfix_charge / easyfixer_charge, and every create path in this backend
 * populates them. They are still the wrong source here, for three reasons:
 *
 *   1. They are written by utils/rate-card-calc.js::computeJobServiceCharges,
 *      which is a DIFFERENT cascade from calculateCharges below. That one
 *      subtracts a fixed leg unclamped (`remaining -= efFixed`) and rounds to
 *      4dp; this one clamps (`Math.min(running, fix)`) and rounds to 2dp. On a
 *      rate card whose fixed leg exceeds what remains, the stored column goes
 *      negative where the cascade floors at zero. Two formulas, one column.
 *   2. They are a SNAPSHOT, written at insert and on quantity change. A later
 *      rate-card edit leaves them stale while this cascade moves.
 *   3. Rows created before the columns were added to the INSERTs (2026-06-03)
 *      hold nothing at all, and neither do rows the still-live legacy Java CRM
 *      writes.
 *
 * "Prefer stored, fall back to computed" is the worst of the three: it picks a
 * different formula per row, so the disagreement becomes intermittent instead
 * of consistent, which is harder to notice and harder to explain.
 *
 * COST. One query per call, regardless of how many services the job has — the
 * cascade itself is pure arithmetic over the rows already fetched. Callers that
 * need both this and their own data pay two queries, not N+1.
 */

// The active-row rule is shared with job-charges.service.js's own services
// query so the two row SETS cannot diverge — a row present in one and absent
// from the other would silently drop its charges from the Billing total.
const ACTIVE_SERVICE_ROWS = '(js.job_service_status IS NULL OR js.job_service_status <> 0)';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Rate-card breakdown for every active service line on a job.
 *
 * @param {number} jobId
 * @returns {Promise<{ job_id: number, lineItems: object[], totals: object }>}
 */
async function breakdownForJob(jobId) {
  const id = Number(jobId);
  const [rows] = await pool.query(
    `SELECT js.job_service_id, js.service_id, js.quantity, js.total_charge,
            cs.total_amount,
            cs.easyfix_direct_fixed, cs.easyfix_direct_variable,
            cs.overhead_fixed, cs.overhead_variable,
            cs.client_fixed, cs.client_variable,
            st.service_type_name,
            sc.service_catg_name
       FROM tbl_job_services js
       LEFT JOIN tbl_client_service cs ON cs.client_service_id = js.service_id
       LEFT JOIN tbl_service_type   st ON st.service_type_id   = js.service_type_id
       LEFT JOIN tbl_service_catg   sc ON sc.service_catg_id   = js.service_category_id
      WHERE js.job_id = ?
        AND ${ACTIVE_SERVICE_ROWS}
      ORDER BY js.job_service_id ASC`,
    [id],
  );

  const lineItems = rows.map((r) => {
    const qty = Number(r.quantity) || 1;
    /*
     * Per-unit cascade — uses tbl_client_service.total_amount as the
     * single-unit total. Falls back to js.total_charge/qty if the
     * client_service row is missing the cost cols (legacy rows).
     *
     * The fallback DIVIDES because js.total_charge is a PER-UNIT column
     * despite its name (utils/rate-card-calc.js writes Math.round(unitPrice)
     * into it) — so the division is only ever exercised on a legacy row where
     * the stored value already went through a legacy writer.
     */
    const perUnitTotal = Number(r.total_amount)
      || (Number(r.total_charge) / qty)
      || 0;
    const perUnit = calculateCharges({
      totalCharge:           perUnitTotal,
      easyfixDirectFixed:    r.easyfix_direct_fixed,
      easyfixDirectVariable: r.easyfix_direct_variable,
      overheadFixed:         r.overhead_fixed,
      overheadVariable:      r.overhead_variable,
      clientFixed:           r.client_fixed,
      clientVariable:        r.client_variable,
    });
    const scale = (b) => ({
      variableAmt: round2(b.variableAmt * qty),
      fixedAmt:    round2(b.fixedAmt * qty),
      total:       round2(b.total * qty),
    });
    return {
      job_service_id: r.job_service_id,
      service_id: r.service_id,
      service_type_name: r.service_type_name,
      service_category_name: r.service_catg_name,
      quantity: qty,
      perUnit,
      lineTotal: {
        totalCharge:   round2(perUnit.totalCharge * qty),
        easyfixDirect: scale(perUnit.easyfixDirect),
        overhead:      scale(perUnit.overhead),
        clientShare:   scale(perUnit.clientShare),
        remainder:     round2(perUnit.remainder * qty),
      },
    };
  });

  // Aggregate totals across all line items.
  const totals = lineItems.reduce((acc, li) => {
    acc.totalCharge += li.lineTotal.totalCharge;
    acc.easyfixDirect += li.lineTotal.easyfixDirect.total;
    acc.overhead      += li.lineTotal.overhead.total;
    acc.clientShare   += li.lineTotal.clientShare.total;
    acc.remainder     += li.lineTotal.remainder;
    return acc;
  }, { totalCharge: 0, easyfixDirect: 0, overhead: 0, clientShare: 0, remainder: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { job_id: id, lineItems, totals };
}

/*
 * The two figures a billing surface actually needs, keyed by job_service_id.
 *
 * client = lineTotal.totalCharge — the rate-card price for the LINE (per-unit
 *          × quantity). The Billing tab previously summed js.total_charge raw,
 *          which is per-unit and never multiplied, so a qty-3 line was counted
 *          once. That is a separate bug from the missing tx and is fixed by the
 *          same change.
 * tx     = lineTotal.remainder — the L4 residual, what the technician is owed.
 *
 * NOT clientShare, which is the operator true-up bucket carved out at L3. It is
 * the one layer whose name says "client" and whose value is not what the client
 * pays, and every layer is a rupee figure of a believable size, so picking it
 * would be invisible to review.
 */
async function serviceChargeMap(jobId) {
  const { lineItems } = await breakdownForJob(jobId);
  const map = new Map();
  for (const li of lineItems) {
    map.set(Number(li.job_service_id), {
      client_charge: li.lineTotal.totalCharge,
      tx_charge:     li.lineTotal.remainder,
    });
  }
  return map;
}

module.exports = { breakdownForJob, serviceChargeMap, ACTIVE_SERVICE_ROWS };
