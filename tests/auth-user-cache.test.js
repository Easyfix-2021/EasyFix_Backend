/*
 * findUserById is cached. These tests exist because that fix is INVISIBLE to
 * every assertion you would normally write.
 *
 * Background (2026-09-08): the pool (connectionLimit 30, queueLimit 50 —
 * db.js) hit "Queue limit reached" with findUserById on the stack, called
 * from requireAuth. It runs before ANY work on /api/admin, /api/client,
 * /api/mobile and /api/shared, so it is the single highest-frequency query
 * in the process. services/auth.service.js now serves it from a 15s
 * per-user entry in utils/ttl-cache.
 *
 * WHY THE ASSERTIONS LOOK LIKE THIS. On the happy path a cache returns
 * byte-identical rows — same object shape, same values, same nulls. A test
 * that asserted on the RETURN VALUE would pass identically against the
 * uncached version and would therefore prove nothing about the fix. So
 * every assertion here is on the CALL TRACE: how many queries reached the
 * pool. Verified by positive control — running this file with
 * AUTH_USER_CACHE_TTL_MS=0 must turn the hit-count assertions RED.
 *
 * WHY THE FAKE EVALUATES `user_id` RATHER THAN RETURNING A CANNED ROW.
 * The most important test in this file is the one that proves user A's row
 * is never served to user B — that is the whole risk of keying a shared
 * cache by a user id. A fake that answered every SELECT with the same row
 * would report a bleeding cache as perfectly correct: the bleed and the
 * fake would be indistinguishable. So the route below reads params[0] and
 * serves the matching row, which makes "wrong row returned" a real,
 * observable failure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * No /g flag, deliberately: a global regex's .test() carries lastIndex
 * between calls, and this one is reused across every call in the trace —
 * it would start skipping matches and silently under-count the queries
 * these tests exist to count.
 */
const USER_SELECT = /SELECT[\s\S]*FROM tbl_user/i;

// The DB, as far as this file is concerned. Two DISTINCT rows: the
// anti-bleed test needs values that differ in the columns that decide
// authorization (user_role, the manage_* scopes), not just in a label.
const USERS = {
  7: {
    user_id: 7, user_code: 'EF000007', user_name: 'Seven', official_email: 'seven@easyfix.in',
    user_role: 2, user_type_id: 5, city_id: 1, manage_cities: '1,2', manage_states: '10',
    manage_clients: null, manage_verticals: null, user_status: 1,
  },
  9: {
    user_id: 9, user_code: 'EF000009', user_name: 'Nine', official_email: 'nine@easyfix.in',
    user_role: 13, user_type_id: 5, city_id: 4, manage_cities: '77', manage_states: '20',
    manage_clients: '5', manage_verticals: null, user_status: 1,
  },
};

// Armed by the rejection test; consumed by the next query.
let failNext = null;

const fake = installFakePool([
  [USER_SELECT, (sql, params) => {
    if (failNext) { const err = failNext; failNext = null; throw err; }
    // Evaluate the filter — see the header. `user_status = 1 AND
    // user_type_id = 5` are literals in the SQL, so id is the only param.
    const row = USERS[Number(params[0])];
    return row ? [row] : [];
  }],
]);

// AFTER the fake is installed: auth.service captures the pool by destructure
// at require time, and installFakePool swaps the methods on that same object.
const auth = require('../services/auth.service');

test.after(() => fake.restore());

/** Queries that actually reached the pool since the last reset. */
const queryCount = () => fake.calls.filter((c) => USER_SELECT.test(c.sql)).length;

/** Fresh trace + empty cache, so each test starts cold. */
function reset() {
  fake.reset();
  failNext = null;
  auth.invalidateUserCache(); // no arg → clearPrefix, not the shared store
}

test('two sequential calls for the same id inside the TTL issue ONE query', async () => {
  reset();
  const first = await auth.findUserById(7);
  const second = await auth.findUserById(7);

  assert.equal(queryCount(), 1, 'second call must be served from cache');
  // The saving must not have cost correctness.
  assert.equal(second.user_id, 7);
  assert.equal(second.user_role, 2);
  assert.deepEqual(second, first);
});

test('different ids do NOT share an entry — no cross-user bleed', async () => {
  /*
   * THE test in this file. A cache keyed by a user id is exactly the shape
   * that leaks one principal's row to another, and the consequence is not a
   * wrong label: user_role selects the route group, manage_cities/_states
   * are the geo allowlist. Serving row 7 to a request for row 9 would hand
   * user 9 user 7's role and territory.
   */
  reset();
  const seven = await auth.findUserById(7);
  const nine = await auth.findUserById(9);

  assert.equal(queryCount(), 2, 'a second id must not be answered from the first id\'s entry');
  assert.equal(nine.user_id, 9, 'returned the SECOND user\'s row');
  assert.equal(nine.user_role, 13, 'and its role, not user 7\'s');
  assert.equal(nine.manage_cities, '77', 'and its scope, not user 7\'s');
  assert.notEqual(nine.user_id, seven.user_id);

  // And the warm entries stay independent of each other.
  assert.equal((await auth.findUserById(7)).user_id, 7);
  assert.equal((await auth.findUserById(9)).user_id, 9);
  assert.equal(queryCount(), 2, 'both warm entries served without new queries');
});

test('a concurrent burst for one cold id issues ONE query (stampede join)', async () => {
  reset();
  const rows = await Promise.all(Array.from({ length: 25 }, () => auth.findUserById(7)));

  assert.equal(queryCount(), 1, '25 concurrent callers must share one in-flight query');
  assert.equal(rows.length, 25);
  assert.ok(rows.every((r) => r && r.user_id === 7), 'every joiner got the row');
});

test('after invalidation the next call queries again', async () => {
  reset();
  await auth.findUserById(7);
  assert.equal(queryCount(), 1);

  auth.invalidateUserCache(7);

  const after = await auth.findUserById(7);
  assert.equal(queryCount(), 2, 'invalidation must force a re-read');
  assert.equal(after.user_id, 7);
});

test('after the TTL expires the next call queries again', async () => {
  reset();
  await auth.findUserById(7);
  assert.equal(queryCount(), 1);

  /*
   * Clock injection, not a sleep: ttl-cache compares against Date.now(), so
   * moving the clock past the 15s TTL expires the entry instantly and the
   * test stays deterministic (a real wait would make it both slow and
   * flaky). Restored in `finally` — a leaked global clock would corrupt
   * every test after this one.
   */
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60_000;
    const after = await auth.findUserById(7);
    assert.equal(queryCount(), 2, 'an expired entry must not be served');
    assert.equal(after.user_id, 7);
  } finally {
    Date.now = realNow;
  }
});

test('a rejected query is not cached — the next call retries', async () => {
  reset();
  failNext = new Error('Queue limit reached.');

  await assert.rejects(() => auth.findUserById(7), /Queue limit reached/);
  assert.equal(queryCount(), 1);

  // If the rejection had been stored, this would either throw again or
  // resolve to a poisoned entry instead of re-reading.
  const after = await auth.findUserById(7);
  assert.equal(queryCount(), 2, 'the failed key must be evicted, not cached');
  assert.equal(after.user_id, 7);
});

test('a NULL result is not cached — a newly-created user is not locked out', async () => {
  /*
   * findUserById filters `user_status = 1 AND user_type_id = 5`, so an
   * unknown, deactivated, or not-yet-created user returns null. Caching that
   * would lock a user created or reactivated one second ago out for the
   * whole TTL — the negative must expire immediately, not on the clock.
   */
  reset();
  assert.equal(await auth.findUserById(404), null);
  assert.equal(await auth.findUserById(404), null);
  assert.equal(queryCount(), 2, 'each sequential miss must re-read');

  // And the row becoming visible is picked up on the very next call, with
  // no TTL to wait out.
  USERS[404] = { ...USERS[7], user_id: 404, user_name: 'Newly created' };
  try {
    const now = await auth.findUserById(404);
    assert.equal(now && now.user_id, 404, 'a new row is visible immediately');
  } finally {
    delete USERS[404];
  }
});

test('a concurrent burst of MISSES still issues one query', async () => {
  /*
   * The other half of the negative-caching trade: not caching a null must
   * not turn a dead token into a way to hammer the pool. The in-flight join
   * — not a cached negative — is what bounds it.
   */
  reset();
  const rows = await Promise.all(Array.from({ length: 25 }, () => auth.findUserById(404)));

  assert.equal(queryCount(), 1, '25 concurrent misses must share one query');
  assert.ok(rows.every((r) => r === null));
});
