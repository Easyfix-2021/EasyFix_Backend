/*
 * AUTO-UNREACHABLE — turn "we called on three separate days and never got
 * through" into the same Unreachable outcome an operator writes by hand.
 *
 * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * There is no job_status for "unreachable". The Unreachable button in Confirm
 * & Schedule leaves job_status at 9 and writes a tbl_job_comment row at
 * comment_on = 16 (plus tbl_job.call_later = 1, mirrored by addComment). THAT
 * COMMENT is what files a job under "Pending Action from Client". So this sweep
 * writes exactly the same comment through exactly the same service — it does
 * not invent a status, and it does not add a second definition of "pending with
 * the client". One outcome, two ways to reach it: an operator says so, or three
 * days of calls say so.
 *
 * ─── WHAT COUNTS AS AN ATTEMPT ─────────────────────────────────────────────
 *
 * tbl_job_caller_info, NOT the comment log. The comment log records what an
 * operator chose to write down; on the open book exactly ONE job has reached
 * three operator-marked days, which is why the client portal's three-day tile
 * looks broken. Calls are the thing the business rule actually talks about.
 *
 * The predicate has to mean what the label says, and that is the whole trap
 * here. An earlier proposal counted "we placed a call and our own leg did not
 * fail", which scored 29,875 jobs — until it was broken down and 26.5% of them
 * had three or more days on which the customer ANSWERED. Telling a client their
 * customer was unreachable on a day the customer spoke to us is worse than
 * saying nothing. So the rule is the narrow one: the CUSTOMER'S leg rang and did
 * not connect.
 *
 * NULL caller_status (about 12% of outbound rows — the report cron never
 * stamped them) is EXCLUDED, not assumed failed. Excluding it can only make the
 * rule stricter, and "stricter" is the correct direction for a claim we put in
 * front of a client about their own customer.
 *
 * Two vocabularies exist in this column — an UPPERCASE ..._LEG2 set and a
 * lowercase set, from different telephony providers — so both are listed. They
 * live in ONE constant because a predicate spelled twice is a predicate that
 * disagrees with itself.
 */
const logger = require('../logger');
const jobComment = require('./job-comment.service');

/*
 * The pool is resolved LAZILY, never at module scope.
 *
 * `require('../db')` opens a connection pool as a side effect of loading, so a
 * top-level require makes this module unloadable without a database — the unit
 * tests below hand in a fake pool precisely so they need none, and requiring it
 * up here left the test process alive forever with nothing to do. Same reason
 * five handlers in routes/admin/jobs.js require it inside the function body.
 */
function defaultPool() {
  return require('../db').pool;
}

/** The customer's leg rang and did not connect. Both provider vocabularies. */
const FAILED_CUSTOMER_LEG = Object.freeze([
  'NOANSWER_LEG2', 'BUSY_LEG2', 'FAILED_LEG2',      // uppercase / _LEG2 provider
  'NOANSWER', 'BUSY', 'CONGESTION', 'CANCEL',        // uppercase, unsuffixed
  'no_answer', 'busy', 'failed',                     // lowercase provider
]);

/** Distinct days with at least one failed call before we call it unreachable. */
const MIN_DAYS = 3;

/** Jobs that have left the board are not waiting on anybody. */
const TERMINAL_STATUSES = Object.freeze([3, 5, 6, 7]);

const AUTO_REASON = Object.freeze({
  actionType: 25,                 // UnReachable
  userType: 1,                    // EasyFix — we inferred it
  desc: 'No contact after repeated call attempts',
});

let cachedReasonId;
/*
 * Resolved from the row, never hardcoded: ids differ per environment. Returns
 * null when the seed has not run, and every caller treats that as "do nothing"
 * rather than writing a comment with a NULL discriminator we could never
 * recognise again — an unrecognisable marker would make the sweep re-mark the
 * same job on every run.
 */
async function autoReasonId(pool) {
  if (!pool) pool = defaultPool();
  if (cachedReasonId !== undefined) return cachedReasonId;
  /*
   * Destructured defensively, in two steps rather than `const [[row]] =`.
   * mysql2 always answers [rows, fields], but a test harness answering with a
   * bare [] made the nested pattern THROW — and because this runs before the
   * caller's main query, the throw took out the whole handler rather than
   * degrading to "no reason row". A lookup that cannot find its row must return
   * null, never explode into the request it was meant to inform.
   */
  const [rows] = await pool.query(
    `SELECT id FROM action_taken_reason
      WHERE action_type = ? AND user_type = ? AND action_desc = ? LIMIT 1`,
    [AUTO_REASON.actionType, AUTO_REASON.userType, AUTO_REASON.desc],
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  cachedReasonId = row ? Number(row.id) : null;
  return cachedReasonId;
}

/*
 * Jobs that have earned the marker and do not have it yet.
 *
 * The NOT EXISTS is the idempotency guard, and it is keyed on the reason id
 * rather than on comment text: this must be recognisable after somebody edits
 * the wording. It deliberately checks only for THIS reason, so a job an
 * operator already marked by hand can still receive the automatic one — those
 * are different statements ("an operator says so" vs "the call log says so"),
 * and collapsing them would hide the second.
 */
function qualifyingSql() {
  const failedPh = FAILED_CUSTOMER_LEG.map(() => '?').join(', ');
  const termPh = TERMINAL_STATUSES.map(() => '?').join(', ');
  return `
    SELECT jci.job_id,
           COUNT(DISTINCT DATE(jci.inserted_time)) AS failed_days,
           MAX(jci.inserted_time)                  AS last_attempt
      FROM tbl_job_caller_info jci
      JOIN tbl_job j ON j.job_id = jci.job_id
     WHERE jci.call_type = 'OUT'
       AND jci.job_id > 0
       AND jci.caller_status IN (${failedPh})
       AND j.job_status NOT IN (${termPh})
       AND NOT EXISTS (
             SELECT 1 FROM tbl_job_comment c
              WHERE c.job_id = j.job_id AND c.enum_reason_id = ?
           )
     GROUP BY jci.job_id
    HAVING failed_days >= ?
     ORDER BY failed_days DESC, last_attempt DESC
     LIMIT ?`;
}

async function findQualifying(pool, { minDays = MIN_DAYS, limit = 500 } = {}) {
  if (!pool) pool = defaultPool();
  const reasonId = await autoReasonId(pool);
  if (reasonId == null) return { reasonId: null, rows: [] };
  const [res] = await pool.query(qualifyingSql(),
    [...FAILED_CUSTOMER_LEG, ...TERMINAL_STATUSES, reasonId, minDays, limit]);
  return { reasonId, rows: Array.isArray(res) ? res : [] };
}

/*
 * One sweep. Writes through jobComment.addComment so the comment_on=16 side
 * effects — job_stage forced to 9, tbl_job.call_later = 1, the remarks mirror —
 * happen identically to the manual path. commented_by is omitted: the writer is
 * this process, and tbl_job_comment.commented_by is a tbl_user FK, so any id we
 * invented there would resolve to a real employee who did nothing.
 */
async function sweep(pool, { minDays = MIN_DAYS, limit = 500, dryRun = false } = {}) {
  if (!pool) pool = defaultPool();
  const { reasonId, rows } = await findQualifying(pool, { minDays, limit });
  if (reasonId == null) {
    logger.warn('auto-unreachable: reason row not seeded on this host — sweep skipped');
    return { marked: 0, skipped: 0, eligible: 0, seeded: false };
  }
  if (dryRun) return { marked: 0, skipped: rows.length, eligible: rows.length, seeded: true };

  let marked = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      await jobComment.addComment(Number(r.job_id), {
        comments: `Customer could not be reached on ${r.failed_days} separate days of call attempts.`,
        comment_on: 16,
        enum_reason_id: reasonId,
      });
      marked += 1;
    } catch (e) {
      // One bad row must not end the sweep — the next run retries it, because
      // the NOT EXISTS guard only clears once the comment actually landed.
      skipped += 1;
      logger.warn('auto-unreachable: could not mark job ' + r.job_id + ' · ' + e.message);
    }
  }
  logger.info(`auto-unreachable: marked ${marked}, skipped ${skipped}, of ${rows.length} eligible`);
  return { marked, skipped, eligible: rows.length, seeded: true };
}

module.exports = {
  FAILED_CUSTOMER_LEG, MIN_DAYS, TERMINAL_STATUSES, AUTO_REASON,
  autoReasonId, qualifyingSql, findQualifying, sweep,
  _resetCache: () => { cachedReasonId = undefined; },
};
