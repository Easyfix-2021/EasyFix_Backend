/*
 * Offering a BOOKED job that still carries an OWNER.
 *
 * ─── THE STUCK JOB THIS EXISTS FOR (2026-09-10) ─────────────────────────────
 *
 * `job_status = 0 (BOOKED) AND fk_easyfixter_id IS NOT NULL` is a state NO
 * writer in this backend produces — assign() bumps 0 -> 1 in the same UPDATE,
 * applyUnassignLocked clears status and owner together, acceptOffer sets both,
 * createJob never inserts fk_easyfixter_id. It arrives from the legacy Java CRM,
 * whose assign wrote the owner and left the job BOOKED ("Pending App Ack", still
 * modelled by name in quicksight-priority-jobs.service.js).
 *
 * Schedule & Assign gates only on job_status, so the modal opens for such a row
 * and its one commit button hit offerToTechnicians' JOB_NOT_OFFERABLE guard
 * every single time. Production job 534947 — BOOKED, owned, ZERO tbl_job_offer
 * rows — absorbed 16 attempts from two operators before they gave up. It was the
 * ONLY job in the entire production log to hit that 409, so the row was stuck;
 * the defect was that the UI's only exit from it was a wall.
 *
 * ─── WHAT IS ASSERTED, AND WHY THESE AND NOT OTHERS ────────────────────────
 *
 * The fix reuses assign()'s release-then-offer, so the risk is not "does it
 * work" but BLAST RADIUS and ORDER:
 *
 *   • order — the release must COMMIT before the offer, or the offer meets the
 *     very guard being worked around and 409s. Pinned by index, not presence.
 *   • eligibility-before-release — an ineligible incoming technician must not
 *     leave the job OWNERLESS as the side effect of a request that then 400s.
 *     This is the one way the change could lose a live assignment.
 *   • BOOKED-only — a SCHEDULED owned job must still 409 here, so reassign
 *     keeps flowing through assign() (which carries the reschedule reason).
 *   • no spurious release — the ordinary ownerless offer must not gain a write.
 *
 * Non-destructive: fake pool, per-test STOP-sentinel, no real DB.
 * Runner: `node --test --test-force-exit`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const active = (id) => ({
  efr_id: id,
  efr_status: 1,
  is_technician_verified: 1,
  efr_manager_id: null,
  scheduled_reactivation_date: null,
  lifecycle_status: 'ACTIVE',
  lifecycle_reason_code: null,
  lifecycle_reason: null,
  lifecycle_version: 1,
});

// The reported shape: BOOKED (0) yet owned by technician 99. The offer goes to 42.
const defaults = () => ({
  props: { 'job.offer.flow.enabled': 'true' },
  techRows: [active(42)],
  job: { job_id: 100, job_status: 0, fk_easyfixter_id: 99 },
  lockedJob: { job_id: 100, job_status: 0, fk_easyfixter_id: 99 },
  // The release is a real state change mid-flow: offerToTechnicians re-reads
  // the row under lock and refuses an owned job, so the fake must model the
  // freed row or the second half of the flow is never exercised.
  releasedJob: { job_id: 100, job_status: 0, fk_easyfixter_id: null },
  latestOffer: [],
  stopOn: /INSERT INTO tbl_job_offer/,
});
const scenario = defaults();

const RELEASE_UPDATE = /UPDATE tbl_job\s+SET fk_easyfixter_id = NULL/;
const DIRECT_ASSIGN_UPDATE = /^\s*UPDATE tbl_job SET fk_easyfixter_id = \?/;

let calls;
const released = () => calls.some((c) => RELEASE_UPDATE.test(c.sql));

const fake = installFakePool(
  [
    [/FROM easyfix_properties/i, () =>
      Object.entries(scenario.props).map(([property_key, property_value]) => ({ property_key, property_value }))],
    [/SHOW COLUMNS/i, []],
    [/FROM information_schema/i, [{ column_count: 6, history_count: 1 }]],
    [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
    [/FROM tbl_easyfixer e\s+WHERE e\.efr_id IN/, () => scenario.techRows],
    [/FROM tbl_easyfixer e\s+WHERE e\.efr_id = \?/, () => scenario.techRows],
    // One route, three views of the same row: the unlocked getJobMeta preload,
    // the locked re-read, and — once the release has committed — the freed row
    // the offer is actually issued against.
    [/SELECT job_id, job_status, fk_easyfixter_id/, (sql) => [
      released() ? scenario.releasedJob : (/FOR UPDATE/i.test(sql) ? scenario.lockedJob : scenario.job),
    ]],
    [RELEASE_UPDATE, { affectedRows: 1 }],
    [/FROM tbl_job_offer\s+WHERE job_id = \? AND fk_easyfixter_id = \?/, () => scenario.latestOffer],
    [/FROM tbl_job_offer jo/, []],
  ],
  { stopOn: { test: (sql) => scenario.stopOn.test(sql) } },
);
calls = fake.calls;

const propsSvc = require('../services/properties.service');
const jobSvc = require('../services/job.service');

// job.service.js destructures getProperty at require time, so the flag has to be
// driven through the REAL properties cache — a stub on the module would miss.
async function applyProps() { await propsSvc.flushCache(); }

beforeEach(async () => {
  fake.reset();
  Object.assign(scenario, defaults());
  await applyProps();
});

const stopped = (error) => error.__stop === true;
const find = (re) => calls.find((c) => re.test(c.sql));
const has = (re) => calls.some((c) => re.test(c.sql));

/* ─── the bug ───────────────────────────────────────────────────────────── */

test('a BOOKED job with a stale owner can be offered — the claim is released first', async () => {
  await assert.rejects(
    () => jobSvc.offerToTechnicians(100, [42], { user_id: 9 }),
    stopped,
    'reaching the INSERT sentinel is the proof: before the fix this threw JOB_NOT_OFFERABLE',
  );
  assert.ok(has(RELEASE_UPDATE), 'the stale owner must be released');
  assert.ok(has(/INSERT INTO tbl_job_offer/), 'and the offer must actually go out');
  assert.ok(
    !has(DIRECT_ASSIGN_UPDATE),
    'nobody is hard-assigned — an ACCEPT is still what schedules the job',
  );
});

test('the release is scoped to the OUTGOING technician and returns the job to BOOKED', async () => {
  await assert.rejects(() => jobSvc.offerToTechnicians(100, [42], { user_id: 9 }), stopped);
  const release = find(RELEASE_UPDATE);
  assert.match(release.sql, /job_status = 0/, 'BOOKED is what acceptOffer\'s first-wins gate needs');
  assert.match(release.sql, /scheduled_date_time = NULL/);
  assert.ok(release.params.includes(99),
    `the release must name technician 99, got ${JSON.stringify(release.params)} — an unscoped `
    + 'release would clear whoever owns the row by the time it runs');

  // Audited against the OUTGOING technician, or the release reads as an
  // unexplained disappearance. The pool wording matters: this is neither a
  // technician rejection nor a reassign to one named person.
  const history = calls.find((c) => /INSERT INTO scheduling_history/.test(c.sql));
  assert.ok(history, 'the outgoing technician gets their own scheduling_history row');
  assert.equal(history.params[1], 99);
  assert.equal(history.params[3], 'Released to the offer pool');
});

test('ORDER: the release lands before the offer, never after', async () => {
  /*
   * The load-bearing assertion. releaseOwnedJobForReoffer commits in its OWN
   * transaction and offerToTechnicians then re-reads the row under lock — so an
   * offer issued first would meet the exact JOB_NOT_OFFERABLE guard this change
   * routes around, and the 409 would come back for a reason no log line
   * distinguishes from the original bug. Presence proves nothing; index does.
   */
  await assert.rejects(() => jobSvc.offerToTechnicians(100, [42], { user_id: 9 }), stopped);
  const releaseAt = calls.indexOf(find(RELEASE_UPDATE));
  const insertAt = calls.findIndex((c) => /INSERT INTO tbl_job_offer/.test(c.sql));
  assert.ok(releaseAt > -1 && insertAt > -1);
  assert.ok(releaseAt < insertAt,
    `release at ${releaseAt}, offer at ${insertAt} — the offer must come second`);
});

/* ─── the way this change could lose a live assignment ──────────────────── */

test('an INELIGIBLE incoming technician leaves the job OWNED — nothing is released', async () => {
  /*
   * The whole reason eligibility is checked before the release rather than
   * relying on offerToTechnicians' own locked check. Release-then-refuse would
   * strip a real owner off a job as the side effect of a request that FAILED,
   * and no caller would know to put them back.
   */
  scenario.techRows = [];               // technician 42 does not resolve
  await assert.rejects(() => jobSvc.offerToTechnicians(100, [42], { user_id: 9 }));
  assert.ok(!has(RELEASE_UPDATE),
    'the owner must survive a request that never issued an offer');
  assert.ok(!has(/INSERT INTO tbl_job_offer/));
});

/* ─── blast radius ──────────────────────────────────────────────────────── */

test('a SCHEDULED owned job still 409s here — that reassign belongs to assign()', async () => {
  // assign() releases with the operator's chosen reschedule reason and pushes
  // the RescheduleTech webhook. Widening this path to status 1 would silently
  // bypass both, so the narrow gate is the point.
  scenario.job = { job_id: 100, job_status: 1, fk_easyfixter_id: 99 };
  scenario.lockedJob = scenario.job;
  await assert.rejects(
    () => jobSvc.offerToTechnicians(100, [42], { user_id: 9 }),
    (e) => e.code === 'JOB_NOT_OFFERABLE' && e.status === 409,
  );
  assert.ok(!has(RELEASE_UPDATE), 'and it must not release anything on the way out');
});

test('an ordinary OWNERLESS BOOKED offer gains no release write', async () => {
  // The negative control for the branch itself: if the condition were wrong
  // (say `!= null` inverted, or a truthiness test that 0 satisfies) every
  // normal offer would start writing an unassign nobody asked for.
  scenario.job = { job_id: 100, job_status: 0, fk_easyfixter_id: null };
  scenario.lockedJob = scenario.job;
  await assert.rejects(() => jobSvc.offerToTechnicians(100, [42], { user_id: 9 }), stopped);
  assert.ok(has(/INSERT INTO tbl_job_offer/), 'the plain offer still goes out');
  assert.ok(!has(RELEASE_UPDATE), 'with nothing to release');
  assert.ok(!has(/INSERT INTO scheduling_history/), 'and no phantom unassign in the audit trail');
});

test('a COMPLETED job is still refused, owner or not', async () => {
  // applyUnassignLocked only accepts BOOKED/SCHEDULED, so a released COMPLETED
  // job was never possible — but the guard, not that coincidence, is what should
  // stop it, and the error the operator sees must stay the offerable one.
  scenario.job = { job_id: 100, job_status: 3, fk_easyfixter_id: 99 };
  scenario.lockedJob = scenario.job;
  await assert.rejects(
    () => jobSvc.offerToTechnicians(100, [42], { user_id: 9 }),
    (e) => e.code === 'JOB_NOT_OFFERABLE',
  );
  assert.ok(!has(RELEASE_UPDATE));
});
