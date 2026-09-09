/*
 * Pool saturation reporting — the probe that has to be RIGHT when everything
 * else is wrong.
 *
 * Context: on 2026-09-08 the pool hit "Queue limit reached." with nothing
 * watching it. `getPoolStats()` existed but published only lifetime counters,
 * which never fall and therefore cannot say whether the pool is in trouble NOW.
 *
 * The dangerous failure mode for a monitor is not "it errors" — it is "it
 * reports a healthy-looking constant". This suite exists mostly to make that
 * impossible in two specific ways:
 *
 *   1. readLiveGauges() reads mysql2 INTERNALS. The first implementation
 *      guarded them with Array.isArray(), which is false for the Denque
 *      instances mysql2 v3 actually uses — so the probe returned null on every
 *      real pool while reading perfectly in review. A mysql2 upgrade can do the
 *      same thing again. `the gauge reader survives the real mysql2 pool shape`
 *      is the guard: it runs against a genuine createPool() object, so it goes
 *      red on the upgrade that moves the internals instead of silently
 *      reporting zeros forever.
 *
 *   2. The classifier is asserted on both sides of every threshold. A rule that
 *      never returns 'saturated' is indistinguishable from a pool that is never
 *      saturated, which is exactly the reading that lost us the incident.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

const { _readLiveGauges, _classifySaturation } = require('../db');

const LIMIT = 30;
const QUEUE_MAX = 50;
const classify = (live) => _classifySaturation(live, LIMIT, QUEUE_MAX);

test('the gauge reader survives the real mysql2 pool shape', () => {
  // createPool() does NOT dial — this needs no database.
  const probe = mysql.createPool({ host: '127.0.0.1', user: 'nobody', connectionLimit: 3, queueLimit: 5 });
  try {
    const core = probe.pool;
    assert.ok(core, 'mysql2/promise pool must expose .pool — readLiveGauges() reads through it');
    for (const key of ['_allConnections', '_freeConnections', '_connectionQueue']) {
      assert.equal(
        typeof core[key]?.length, 'number',
        `mysql2 moved ${key}: readLiveGauges() will return null and every saturation `
        + 'reading becomes "unknown". Re-point the reader before shipping this upgrade.'
      );
    }
  } finally {
    probe.pool.end(() => {});
  }
});

test('a cold pool reads ok, and the numbers are real rather than defaulted', () => {
  const live = _readLiveGauges();
  assert.notEqual(live, null, 'the app pool must be readable — a null gauge reports "unknown", which reads as healthy');
  for (const k of ['open', 'free', 'inUse', 'queued']) {
    assert.equal(typeof live[k], 'number', `${k} must be numeric`);
  }
});

test('ok: spare connections and nothing waiting', () => {
  assert.equal(classify({ open: 4, free: 3, inUse: 1, queued: 0 }).status, 'ok');
});

test('busy: every connection checked out, even with an empty queue', () => {
  // The boundary matters: inUse === limit with queued 0 is the last moment
  // before requests start waiting, and it must not read as 'ok'.
  assert.equal(classify({ open: 30, free: 0, inUse: 30, queued: 0 }).status, 'busy');
  assert.equal(classify({ open: 29, free: 0, inUse: 29, queued: 0 }).status, 'ok',
    'below the limit with nothing queued is genuinely fine');
});

test('busy: anything actually waiting is busy regardless of inUse', () => {
  assert.equal(classify({ open: 10, free: 0, inUse: 10, queued: 1 }).status, 'busy');
});

test('saturated fires BELOW the hard ceiling — it is a warning, not a post-mortem', () => {
  // 50% of queueLimit. If this only fired at queueLimit it would arrive at the
  // same moment as "Queue limit reached." and warn nobody in time.
  assert.equal(classify({ open: 30, free: 0, inUse: 30, queued: 24 }).status, 'busy');
  assert.equal(classify({ open: 30, free: 0, inUse: 30, queued: 25 }).status, 'saturated');
  assert.equal(classify({ open: 30, free: 0, inUse: 30, queued: 50 }).status, 'saturated');
});

test('unknown is distinguishable from ok, and carries its reason', () => {
  // The whole point: an unreadable probe must NOT look like a healthy pool.
  const out = classify(null);
  assert.equal(out.status, 'unknown');
  assert.notEqual(out.status, 'ok');
  assert.match(out.reason, /not readable/);
});

test('thresholds track the configured limits rather than hardcoded numbers', () => {
  // A smaller pool must saturate proportionally sooner, or the alert is tuned
  // to one environment and silent in every other.
  const small = _classifySaturation({ open: 5, free: 0, inUse: 5, queued: 3 }, 5, 6);
  assert.equal(small.status, 'saturated', 'queued 3 of queueLimit 6 is past the half-way mark');
  const large = _classifySaturation({ open: 5, free: 0, inUse: 5, queued: 3 }, 5, 100);
  assert.equal(large.status, 'busy', 'the same 3 queued against a 100-deep queue is not saturation');
});
