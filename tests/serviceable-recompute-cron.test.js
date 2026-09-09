'use strict';
/*
 * The Serviceable-pincode recompute has a schedule (2026-09-09).
 *
 * `tbl_pincode.pincode_status = 1` means "covered by at least one ACTIVE,
 * VERIFIED technician". Nothing kept that true: creation used to stamp it
 * Serviceable unconditionally, and `recomputeServiceableStatus` — the only code
 * that reconciles the flag with reality — had exactly one caller, a manual
 * admin button. Creation now computes the flag honestly, but coverage CHANGES
 * afterwards (a technician is verified, edits their work area, is deactivated),
 * so without a timer the flag drifts again in both directions.
 *
 * These assertions are source-derived because loading server/scheduler.js runs
 * its registrations against a live database — the same reason
 * tests/scheduled-job-test-kind.test.js reads the file. Where a runtime check
 * is possible without that (validating the cron expression through node-cron
 * itself) it is used, because a regex cannot tell a valid schedule from a typo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const ROOT = path.join(__dirname, '..');
const SCHEDULER = fs.readFileSync(path.join(ROOT, 'server', 'scheduler.js'), 'utf8');

const JOB_ID = 'pincode-serviceable-recompute';
const PROPERTY = 'pincode.serviceable_recompute.enabled';
const CRON = '45 3 * * *';

test('the job is registered, and its schedule is a valid cron expression', () => {
  assert.ok(SCHEDULER.includes(`id: '${JOB_ID}'`), `no job registered with id ${JOB_ID}`);
  assert.ok(SCHEDULER.includes(`cron: '${CRON}'`), `the job must be scheduled at ${CRON}`);
  // Runtime, via the library that will actually parse it. A source regex would
  // happily accept '45 3 * *' or '75 3 * * *' and the job would simply never run.
  assert.equal(cron.validate(CRON), true, `${CRON} is not a valid cron expression`);
});

test('nothing else is scheduled at the same minute', () => {
  /*
   * The recompute UPDATEs the whole pincode table twice inside one transaction,
   * so it holds a table-wide lock. Another job firing in the same minute would
   * queue behind that lock — and the scheduler has no overlap protection ACROSS
   * jobs, only within one (invokeJob's re-entrancy guard).
   */
  const expressions = [...SCHEDULER.matchAll(/cron: '([^']+)'/g)].map((m) => m[1]);
  const sameSlot = expressions.filter((e) => e === CRON);
  assert.equal(sameSlot.length, 1,
    `${sameSlot.length} jobs share the slot ${CRON} — pick a different minute for one of them`);
  assert.ok(expressions.length > 15, `only ${expressions.length} cron expressions found — the `
    + 'extraction regex has stopped matching, so "no collision" would be vacuous');
});

test('the gate is DEFAULT-OFF, deliberately', () => {
  /*
   * This repo uses two gate polarities: `!== 'false'` for always-on infra crons
   * and `=== 'true'` for jobs an operator opts into. A brand-new nightly
   * table-lock belongs in the second group — the operator picks the window.
   * If someone later flips this to a default-ON kill-switch, that should be a
   * conscious change, not a copy-paste from the job above it.
   */
  const gate = SCHEDULER.match(
    /const serviceableRecomputeEnabled\s*=\s*[\s\S]{0,200}?;/,
  );
  assert.ok(gate, 'the enable gate must exist');
  assert.match(gate[0], /=== 'true'/, 'must be opt-in (=== \'true\'), not a default-ON kill-switch');
  assert.doesNotMatch(gate[0], /!== 'false'/, 'a default-ON gate would add a nightly table lock nobody asked for');
});

test('the property name is identical in the gate, the skip reason and the log', () => {
  /*
   * The knob is named in three places. A typo in any one of them produces a
   * setting that either does nothing or cannot be found by the person told to
   * flip it — and nothing else in the system would notice.
   */
  const mentions = SCHEDULER.split(PROPERTY).length - 1;
  assert.ok(mentions >= 3,
    `'${PROPERTY}' appears ${mentions} time(s); it must name the gate, the skipReason and the `
    + 'startup log identically, or the documented switch does not match the real one');
});

test('the skip reason says what stays broken while it is off', () => {
  // A skipReason that only says "disabled" leaves the reader unable to judge
  // whether to enable it. This one has a real consequence and should say so.
  const block = SCHEDULER.match(/serviceableRecomputeJob\.skipReason = "[^"]+"/g) || [];
  const opt = block.find((b) => b.includes(PROPERTY));
  assert.ok(opt, 'the opt-in skipReason must name the property');
  assert.match(opt, /self-heal|Non-Serviceable/i,
    'the skip reason must state the consequence — that the flag stops self-healing — not just '
    + 'that the job is disabled');
});

test('the runner calls the same function the manual button calls', () => {
  /*
   * The admin "Refresh Status" button (routes/admin/pincodes.js) already calls
   * recomputeServiceableStatus. The cron must reuse it rather than growing a
   * second implementation — two definitions of "serviceable" would be worse
   * than the drift this fixes.
   */
  const runner = SCHEDULER.match(/id: 'pincode-serviceable-recompute'[\s\S]*?runner: async \(\) => \{[\s\S]*?\n    \},/);
  assert.ok(runner, 'the runner must exist');
  assert.match(runner[0], /recomputeServiceableStatus\(/, 'must call recomputeServiceableStatus');

  const routes = fs.readFileSync(path.join(ROOT, 'routes', 'admin', 'pincodes.js'), 'utf8');
  assert.match(routes, /recomputeServiceableStatus\(/,
    'the manual Refresh Status button must still call the same function — if it stopped, this '
    + 'test is comparing the cron against something nobody runs');
});
