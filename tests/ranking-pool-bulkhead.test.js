/*
 * The ranking stats fan-out must never take more than its share of the pool.
 *
 * Measured cause of the 2026-09-08 outage shape: one rankCandidatesForJob()
 * call peaks at 16 simultaneous pool acquires, held for the whole call. Against
 * production's connectionLimit 30 / queueLimit 50, six concurrent opens need 96
 * acquires against an 80 ceiling — so mysql2 throws "Queue limit reached." to
 * every request in the process, including the per-request auth lookup.
 *
 * Verified end-to-end against the live QA pool (481k jobs, 4.6k active techs)
 * before this suite existed: 6 concurrent opens peaked at 50 in-use connections
 * uncapped vs 20 capped, with byte-identical candidate output at every cap
 * setting. This suite is the cheap CI guard for that property.
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT:
 *
 * 1. It asserts CONCURRENCY, never results. A bulkhead by construction changes
 *    no output, so every result assertion passes just as happily against the
 *    unbounded version and would read as coverage of a fix it cannot see.
 *
 * 2. It drives the REAL gatedQuery (via the _statsGate.run seam) against a
 *    stubbed pool. An earlier draft re-implemented the gate's acquire/release
 *    discipline inside the test and asserted on that — which verifies the
 *    re-implementation and would stay green through any regression in the
 *    shipped one. The stub is the pool, never the gate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/*
 * Replace ../db BEFORE the service is required, so the real gatedQuery runs
 * against a pool we control. Every other module the service pulls in is real.
 */
const fake = {
  inFlight: 0,
  peak: 0,
  calls: 0,
  behaviour: 'ok', // 'ok' | 'throw' | 'mixed'
  reset() { this.inFlight = 0; this.peak = 0; this.calls = 0; this.behaviour = 'ok'; },
};

const dbPath = require.resolve(path.join(ROOT, 'db.js'));
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    pool: {
      async query() {
        const n = fake.calls;
        fake.calls += 1;
        fake.inFlight += 1;
        fake.peak = Math.max(fake.peak, fake.inFlight);
        try {
          await new Promise((r) => { setTimeout(r, 10); });
          if (fake.behaviour === 'throw' || (fake.behaviour === 'mixed' && n % 4 === 0)) {
            const err = new Error('Queue limit reached.');
            throw err;
          }
          return [[], []];
        } finally {
          fake.inFlight -= 1;
        }
      },
    },
    getPoolStats: () => ({}),
    poolSaturation: () => ({ status: 'ok' }),
    testConnection: async () => true,
    closePool: async () => {},
  },
};
const { _statsGate } = require(path.join(ROOT, 'services/candidate-ranking.service'));
const CAP = _statsGate.limit();

/** Fire `n` real gated queries concurrently and report the pool-side peak. */
async function burst(n) {
  fake.reset();
  await Promise.all(Array.from({ length: n }, () => _statsGate.run('SELECT 1', []).catch(() => {})));
  return fake.peak;
}

test('the cap sits BELOW connectionLimit, or it protects nothing', () => {
  // Read the limit the POOL will actually use, not a second copy of the
  // default. With its own `|| '30'` this assertion silently judged the cap
  // against a number db.js had moved past — and it is stricter-than-reality in
  // the safe direction, so it would never have complained.
  // db-pool-config, NOT ../db: this file replaces ../db in require.cache with a
  // fake pool, so anything db.js exports is invisible here. Reading the shared
  // config module is what stops this assertion drifting away from the real one.
  const poolLimit = require('../db-pool-config').poolLimit();
  assert.ok(CAP >= 1, 'a cap of 0 would deadlock every ranking request');
  assert.ok(
    CAP < poolLimit,
    `the ranking bulkhead (${CAP}) must sit below connectionLimit (${poolLimit}) — at or above it, `
    + 'this endpoint can still consume every connection and starve the auth lookup, which is the '
    + 'exact failure it exists to prevent'
  );
});

test('a burst far wider than the cap never exceeds it at the pool', async () => {
  const peak = await burst(CAP * 5);
  assert.ok(peak <= CAP, `pool saw ${peak} simultaneous queries against a cap of ${CAP}`);
  assert.equal(fake.calls, CAP * 5, 'every query must still run — the gate delays, it must not drop');
});

test('the cap holds when every query REJECTS — slots are released on the error path', async () => {
  fake.behaviour = 'throw';
  const peak = await burst(CAP * 4);
  assert.ok(peak <= CAP, `pool saw ${peak} simultaneous queries against a cap of ${CAP}`);
  assert.equal(_statsGate.inFlight(), 0,
    'a slot leaked on the error path permanently shrinks the cap, and the only symptom is '
    + 'ranking getting slower over the life of the process — never an error');
});

test('mixed success and failure still returns every slot', async () => {
  fake.behaviour = 'mixed';
  const peak = await burst(CAP * 4);
  assert.ok(peak <= CAP);
  assert.equal(_statsGate.inFlight(), 0);
});

test('the gate is idle after all bursts', () => {
  assert.equal(_statsGate.inFlight(), 0);
});

test('positive control: the harness CAN observe an over-cap burst', async () => {
  // Without this, every assertion above would pass against a gate that does
  // nothing — the fake pool would simply never be driven wide enough to tell.
  fake.reset();
  await Promise.all(Array.from({ length: CAP * 3 }, () => {
    const p = require(path.join(ROOT, 'db')).pool.query('SELECT 1', []);
    return p.catch(() => {});
  }));
  assert.ok(
    fake.peak > CAP,
    `ungated calls peaked at ${fake.peak}, which is not above the cap ${CAP} — the harness cannot `
    + 'distinguish a working gate from a missing one, so the assertions above prove nothing'
  );
});
