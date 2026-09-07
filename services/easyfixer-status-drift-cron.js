const { pool } = require('../db');
const logger = require('../logger');
const lifecycle = require('./easyfixer-lifecycle.service');
const { withMysqlNamedLock } = require('./mysql-named-lock.service');
const { drainBatches } = require('./bounded-batch-drain');

/*
 * Repair technicians whose two status columns contradict each other.
 *
 * tbl_easyfixer carries efr_status (what the legacy Java CRM reads and writes)
 * and lifecycle_status (what the new CRM renders). transition() is the only
 * writer in this backend and it sets both in one UPDATE, so a disagreement on a
 * verified technician proves an outside write landed after our last one — the
 * legacy CRM, still live, flipping efr_status alone. See statusDriftSql() for
 * the full argument and reconcileLegacyStatus() for why adopting the legacy bit
 * is the right direction.
 *
 * Left alone the technician is stranded: easyfixer-work-eligibility.sqlPredicate
 * ANDs both halves, so they receive no job offers at all while ops reads Active.
 *
 * WHY THIS IS ITS OWN JOB rather than a second pass of the auto-reactivation
 * cron, which it otherwise resembles (same lock shape, same drain helper, same
 * "converge lifecycle_status on a schedule" job description).
 *
 * That cron is gated on `easyfixer.auto_reactivation.enabled`, which reads
 * 'false' today. Riding along would have shipped a repair that never runs, and
 * would have left a data-integrity guarantee switchable by whoever later turns a
 * convenience feature off. A repair for silent corruption must not be able to
 * fail silently for a reason unrelated to itself.
 */

// Deliberately constants, not properties. The reactivation cron's knobs exist
// because ops asked for them; nothing here has ever needed tuning, and a
// property nobody sets is a config surface nobody maintains.
const BATCH_SIZE = 100;
const MAX_BATCHES = 100;
const MAX_RUNTIME_MS = 120000;

/*
 * BLACKLISTED is excluded in SQL, not merely no-oped downstream by
 * reconcileLegacyStatus. Selecting rows the heal will never change would report
 * a permanent "drifted N, healed 0" — indistinguishable from a heal that has
 * broken. They stay in the counts strip's drift number, which is where a human
 * is supposed to see them.
 */
const NEVER_HEALED = "'BLACKLISTED'";

function driftClauses(alias = 'e') {
  return [
    `(${lifecycle.statusDriftSql(alias)})`,
    `${alias}.lifecycle_status NOT IN (${NEVER_HEALED})`,
    // Admin-deleted tombstones carry efr_status = 3; they are not drift.
    `NOT (${alias}.efr_status <=> 3)`,
  ];
}

async function driftIds({ onlyEfrId = null, limit = null, cursor = null } = {}) {
  const params = [];
  const clauses = driftClauses('e');
  if (onlyEfrId != null) {
    clauses.push('e.efr_id = ?');
    params.push(Number(onlyEfrId));
  } else if (cursor) {
    clauses.push('e.efr_id > ?');
    params.push(Number(cursor));
  }
  params.push(onlyEfrId != null ? 1 : (limit || BATCH_SIZE));
  const [rows] = await pool.query(
    `SELECT e.efr_id
       FROM tbl_easyfixer e
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.efr_id ASC
      LIMIT ?`,
    params,
  );
  return rows.map((row) => Number(row.efr_id));
}

async function countDrift() {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS remaining FROM tbl_easyfixer e WHERE ${driftClauses('e').join(' AND ')}`,
  );
  return Number(row?.remaining) || 0;
}

async function processDrift(efrIds) {
  let healed = 0;
  let failed = 0;
  for (const efrId of efrIds) {
    try {
      const result = await lifecycle.reconcileLegacyStatus(efrId);
      if (result.changed) healed += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ efrId, err: error.message }, 'easyfixer status-drift heal failed');
    }
  }
  return { evaluated: efrIds.length, transitioned: healed, healed, failed };
}

async function healDrift({ onlyEfrId = null } = {}) {
  if (!(await lifecycle.hasLifecycleSchema())) {
    return {
      drifted: 0, healed: 0, failed: 0, skipped: true,
      reason: 'lifecycle schema not installed — there are no columns to contradict',
    };
  }
  if (onlyEfrId != null) {
    const ids = await driftIds({ onlyEfrId });
    const result = await processDrift(ids);
    return { drifted: ids.length, healed: result.healed, failed: result.failed, skipped: false };
  }

  /*
   * Keyset walk by efr_id. Every processed row LEAVES the candidate set (its
   * lifecycle_status now agrees), so the cursor cannot revisit or skip: rows
   * behind it are healed, rows ahead are untouched.
   */
  let cursor = null;
  const drained = await drainBatches({
    batchSize: BATCH_SIZE,
    maxBatches: MAX_BATCHES,
    maxRuntimeMs: MAX_RUNTIME_MS,
    loadBatch: async (limit) => {
      const ids = await driftIds({ limit, cursor });
      if (ids.length) cursor = ids[ids.length - 1];
      return ids;
    },
    processBatch: (ids) => processDrift(ids),
    loadRemaining: () => countDrift(),
  });
  return {
    ...drained,
    drifted: drained.processed,
    healed: drained.transitioned,
    skipped: false,
  };
}

async function runDailyHealUnlocked() {
  try {
    const result = await healDrift();
    /*
     * Logged even at zero. Zero is the answer an operator wants from a drift
     * repair, and a line that appears only when something is wrong cannot be
     * told apart from a pass that never ran.
     */
    logger.info(
      `Easyfixer status-drift heal · drifted=${result.drifted || 0}`
      + ` · healed=${result.healed || 0} · failed=${result.failed || 0}`
      + (result.skipped ? ` (skipped — ${result.reason})` : ''),
    );
    return result;
  } catch (error) {
    logger.warn({ err: error.message }, 'easyfixer status-drift heal run failed');
    return { drifted: 0, healed: 0, failed: 1, skipped: true, reason: error.message };
  }
}

async function runDailyHeal() {
  const locked = await withMysqlNamedLock('easyfix:lifecycle:status-drift', runDailyHealUnlocked);
  if (!locked.acquired) {
    return {
      drifted: 0,
      healed: 0,
      failed: 0,
      skipped: true,
      reason: 'another backend replica owns the status-drift lock',
    };
  }
  return locked.result;
}

async function runTest({ sourceId } = {}) {
  const efrId = Number(sourceId);
  if (!Number.isInteger(efrId) || efrId <= 0) {
    return { ok: false, error: 'A valid Easyfixer ID (efr_id) is required.' };
  }
  try {
    const result = await healDrift({ onlyEfrId: efrId });
    return {
      ok: true,
      efr_id: efrId,
      ...result,
      note: result.healed
        ? 'Lifecycle status reconciled with the legacy CRM flag through the audited transition.'
        : 'No change — this technician\'s two status columns already agree (or the row is BLACKLISTED, which is never healed automatically).',
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  runDailyHeal,
  runTest,
  healDrift,
  _internals: {
    driftIds,
    countDrift,
    processDrift,
    driftClauses,
    runDailyHealUnlocked,
    BATCH_SIZE,
  },
};
