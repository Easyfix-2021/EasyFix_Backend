const lifecycleService = require('./easyfixer-lifecycle.service');

/*
 * One reusable SQL/row projection for the question every job flow asks:
 * "may this technician receive a NEW job?"
 *
 * A RECEIVE_NEW_JOB_STATUSES list used to live here and feed the predicate.
 * It was removed with the reconciliation below rather than left exported: it
 * no longer decided anything, and a constant that still reads like the gate is
 * how the next reader ends up editing the wrong thing. The equivalent list is
 * derived inside lifecycleService.reconciledWorkEligibleSql(), from the
 * resolver the nightly repair uses.
 */

function assertAlias(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('invalid SQL alias for easyfixer work eligibility');
  }
}

/*
 * RECONCILED, not a plain AND of the two status columns (2026-09-07).
 *
 * The old predicate required lifecycle_status IN (work-enabled) AND the legacy
 * gate. For any row this backend wrote those two agree by construction —
 * transition() sets both together — so the lifecycle half changed no answer
 * except on DRIFTED rows, where it gave the wrong one: a technician reactivated
 * in the legacy CRM passed the legacy half, failed the lifecycle half, and
 * received no job offers while every screen ops uses read Active. Reported for
 * efr 4980.
 *
 * lifecycleService.reconciledWorkEligibleSql() derives the replacement from the
 * heal's own resolver, so the candidate query, the row projection below and the
 * nightly repair cannot disagree about who may work.
 */
async function sqlPredicate(alias = 'e') {
  assertAlias(alias);
  if (!(await lifecycleService.hasLifecycleSchema())) {
    // No lifecycle columns to consult, and none to contradict the legacy bit.
    return `${alias}.efr_status = 1 AND ${alias}.is_technician_verified = 1`;
  }
  return lifecycleService.reconciledWorkEligibleSql(alias);
}

function fromRow(row) {
  const lifecycle = lifecycleService.lifecycleFromRow(row);
  // Lifecycle is the business policy, while these two legacy columns remain
  // cutover integrity guards. In particular, legacy derivation intentionally
  // tolerates NULL/nonzero status for read compatibility; a write permission
  // must be stricter and match sqlPredicate() exactly so deleted/status-drifted
  // rows can never be assigned by direct ID.
  const legacyEligible = Number(row?.efr_status) === 1
    && Number(row?.is_technician_verified) === 1;
  return {
    lifecycle,
    canOffer: lifecycle.capabilities.receiveNewJobs && legacyEligible,
  };
}

module.exports = {
  sqlPredicate,
  fromRow,
};
