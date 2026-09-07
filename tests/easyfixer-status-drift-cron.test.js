'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { _internals } = require('../services/easyfixer-status-drift-cron');
const { statusDriftSql } = require('../services/easyfixer-lifecycle.service');

const { driftClauses } = _internals;

/*
 * The status-drift repair moves technicians between lifecycle states, so what
 * it SELECTS and whether it actually runs are the whole of its blast radius.
 */

test('the heal selects the drifted rows, minus the two sets it must never touch', () => {
  const where = driftClauses('e').join(' AND ');

  assert.ok(
    where.includes(statusDriftSql('e')),
    'the candidate set must BE the drift predicate, not a second copy of it',
  );
  assert.match(
    where,
    /lifecycle_status NOT IN \('BLACKLISTED'\)/,
    'a blacklist is a deliberate safety decision and is never lifted by a legacy status flip',
  );
  assert.match(
    where,
    /NOT \(e\.efr_status <=> 3\)/,
    'admin-deleted tombstones carry efr_status = 3 and are not drift',
  );
  assert.ok(driftClauses('x').join(' ').includes('x.lifecycle_status'), 'alias must be honoured');
});

/*
 * BLACKLISTED is excluded in SQL rather than left to reconcileLegacyStatus to
 * no-op. Both produce a correct database; only one produces honest counters. A
 * row selected every night and never changed reports a permanent
 * "drifted N, healed 0", which is indistinguishable from a heal that has broken
 * — and the counters are the monitor.
 */
test('excluding BLACKLISTED in SQL is what keeps the counters honest', () => {
  const where = driftClauses('e').join(' AND ');
  assert.ok(
    where.indexOf('BLACKLISTED') > -1,
    'positive control: the exclusion must be in the QUERY, not only downstream',
  );
});

const SCHEDULER = fs.readFileSync(path.join(__dirname, '..', 'server', 'scheduler.js'), 'utf8');

test('the heal is its own job with its own switch, not a rider on another feature', () => {
  /*
   * This is the guard for the mistake that was nearly shipped. The obvious home
   * for the heal was a second pass of the auto-reactivation cron, which it
   * closely resembles. That cron is gated on
   * `easyfixer.auto_reactivation.enabled`, which reads 'false' — so the repair
   * would have been merged, reviewed, deployed and never once executed.
   *
   * More generally: a repair for silent corruption must not be able to fail
   * silently for a reason unrelated to itself.
   */
  assert.match(SCHEDULER, /id: 'easyfixer-status-drift-heal'/, 'the job must be registered');
  assert.match(
    SCHEDULER,
    /getProperty\('easyfixer\.status_drift_heal\.enabled'\)/,
    'it must read its OWN property',
  );

  // And that property must not be the reactivation cron's.
  const block = SCHEDULER.slice(
    SCHEDULER.indexOf("id: 'easyfixer-status-drift-heal'"),
    SCHEDULER.indexOf('Plivo low-balance alert'),
  );
  assert.ok(block.length > 0, 'the drift job block must precede the Plivo job');
  assert.ok(
    !block.includes('auto_reactivation'),
    'the heal must not depend on the auto-reactivation feature switch',
  );
});

test('the heal is reachable by hand while its schedule is off', () => {
  /*
   * The property ships 'false' because this cron writes. That is only tolerable
   * because Trigger Now / Test still work when a job is skipped, which is how a
   * single reported technician gets fixed without enabling a nightly writer.
   */
  const cron = require('../services/easyfixer-status-drift-cron');
  assert.equal(typeof cron.runTest, 'function', 'a per-technician tester must exist');
  assert.match(SCHEDULER, /tester: \(\{ sourceId \}\) => easyfixerStatusDriftCron\.runTest/);
  assert.match(SCHEDULER, /testSourceLabel: 'Easyfixer ID \(efr_id\)'/);
});

test('runTest refuses anything that is not a positive integer id', async () => {
  const cron = require('../services/easyfixer-status-drift-cron');
  for (const bad of [undefined, null, '', 'abc', 0, -3, 1.5]) {
    const result = await cron.runTest({ sourceId: bad });
    assert.equal(result.ok, false, `sourceId=${JSON.stringify(bad)} must be rejected`);
    assert.match(result.error, /valid Easyfixer ID/);
  }
});
