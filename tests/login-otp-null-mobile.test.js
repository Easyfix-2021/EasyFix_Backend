'use strict';
/*
 * A CRM user with no mobile number can still log in.
 *
 * ─── THE LOCKOUT THIS ENCODES (2026-09-10) ─────────────────────────────────
 *
 * tbl_user.mobile_no is nullable, and both halves of the login-OTP flow matched
 * their row with:
 *
 *     WHERE user_email = ? AND user_mobile_no = ?      -- [email, mobile_no]
 *
 * Bind NULL to that second placeholder and the predicate becomes
 * `user_mobile_no = NULL`, which evaluates to NULL — never true. So for a user
 * with no mobile:
 *
 *   • createLoginOtp's "is there an existing row" lookup missed the row it had
 *     itself just written, and every request INSERTed another one;
 *   • verifyLoginOtp's identical lookup missed too, and answered
 *     NO_OTP_ISSUED — "no active OTP — request one first" — while the user was
 *     looking at a valid, unexpired code that was sitting in the table.
 *
 * The user could not log in, and never would have: no amount of re-requesting
 * changes a predicate that cannot match. Reported on production for a user
 * whose row shows a blank mobile; 7 active QA users are in the same state.
 *
 * Two fingerprints made it diagnosable from the data alone, and they are worth
 * remembering because they distinguish "wrote a new row" from "refreshed one":
 * `count` stayed 1 on every row (the UPDATE branch does count = count + 1, so
 * it had never run) and `created_on` stayed NULL (only the INSERT omits it).
 *
 * ─── WHY THIS DOUBLE EVALUATES THE PREDICATE ───────────────────────────────
 *
 * The pre-existing OTP tests match statements with regexes like
 * /SELECT id FROM otp_details/i and hand back canned rows. Those pass whether
 * the SQL says `=` or `<=>`, which is exactly why the bug shipped past a green
 * suite. So the fake below is a small ROW STORE that implements MySQL's NULL
 * semantics and reads the operator out of the SQL: `=` refuses to match a NULL
 * against anything, `<=>` treats NULL as equal to NULL. Revert the service to
 * `=` and these tests fail the way the user did.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.QA_DETERMINISTIC_OTP;          // prod-like

/*
 * The allowlisted fixed-OTP account: resolveLoginOtp returns 2468 in every
 * environment, and createLoginOtp suppresses delivery for it. That buys a
 * deterministic code and no gateway stub — the flow under test is the row
 * lookup, not the dispatch.
 */
const STATIC_EMAIL = 'pradeep@easyfix.in';
const STATIC_OTP = 2468;

/** MySQL comparison semantics, honestly. */
function sqlEq(a, b, nullSafe) {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return nullSafe && an && bn;      // `=` is NULL (falsey); `<=>` is true only if BOTH null
  return String(a) === String(b);
}

let store;    // otp_details rows
let nextId;
let calls;
let userRow;

function install() {
  const db = require('../db');
  db.pool.query = async (sql, params = []) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    calls.push({ sql: text, params });

    if (/FROM tbl_user/i.test(text)) return [[userRow], []];

    if (/FROM otp_details/i.test(text)) {
      // Read the operator the service actually used, per column.
      const emailSafe = /user_email\s*<=>/i.test(text);
      const mobileSafe = /user_mobile_no\s*<=>/i.test(text);
      let rows = store.filter((r) => r.otp_type === 'crm_login'
        && sqlEq(r.user_email, params[0], emailSafe)
        && sqlEq(r.user_mobile_no, params[1], mobileSafe));
      if (/ORDER BY generated_on DESC/i.test(text)) {
        rows = [...rows].sort((x, y) => (y.generated_on - x.generated_on) || (y.id - x.id));
      }
      if (/LIMIT 1/i.test(text)) rows = rows.slice(0, 1);
      return [rows, []];
    }

    if (/^\s*INSERT INTO otp_details/i.test(text)) {
      const [otp, email, mobile, generated_on, valid_up_to] = params;
      const row = {
        id: nextId++, otp, otp_type: 'crm_login', user_email: email,
        user_mobile_no: mobile === undefined ? null : mobile,
        generated_on, valid_up_to, is_expired: 0, count: 1, created_on: null,
      };
      store.push(row);
      return [{ insertId: row.id, affectedRows: 1 }, []];
    }

    if (/^\s*UPDATE otp_details[\s\S]*count = count \+ 1/i.test(text)) {
      const [otp, generated_on, valid_up_to, id] = params;
      const row = store.find((r) => r.id === id);
      if (row) Object.assign(row, { otp, generated_on, valid_up_to, is_expired: 0, count: row.count + 1 });
      return [{ affectedRows: row ? 1 : 0 }, []];
    }

    if (/^\s*UPDATE otp_details SET is_expired = 1/i.test(text)) {
      const row = store.find((r) => r.id === params[0]);
      if (row) row.is_expired = 1;
      return [{ affectedRows: row ? 1 : 0 }, []];
    }

    return [[], []];
  };
  delete require.cache[require.resolve('../services/auth.service')];
  return require('../services/auth.service');
}

/** An internal CRM user; `mobile` null models the locked-out class. */
function makeUser(mobile) {
  return {
    user_id: 9004, user_code: 'E200322', user_name: 'Varun',
    official_email: STATIC_EMAIL, mobile_no: mobile,
    user_role: 11, user_type_id: 5, city_id: null, alternate_no: null,
    manage_clients: null, manage_cities: null, manage_states: null, manage_verticals: null,
    user_status: 1,
  };
}

beforeEach(() => { store = []; nextId = 12269; calls = []; userRow = makeUser(null); });

/* ─── the lockout ──────────────────────────────────────────────────────── */

test('a user with NO mobile number can verify the OTP they were just sent', async () => {
  const auth = install();
  const issued = await auth.createLoginOtp(STATIC_EMAIL);
  assert.equal(issued.found, true, 'the OTP must be issued');
  assert.equal(store.length, 1, 'exactly one row written');

  const out = await auth.verifyLoginOtp(STATIC_EMAIL, STATIC_OTP);
  assert.equal(out.ok, true,
    `verify must succeed. reason=${out.reason} — NO_OTP_ISSUED here is the production `
    + 'lockout: `user_mobile_no = NULL` is never true, so the row that was just written '
    + 'cannot be found by the code that wrote it.');
});

test('re-requesting REFRESHES the row instead of piling up new ones', async () => {
  /*
   * The user's second symptom, and the same cause: a lookup that cannot match
   * falls through to the INSERT branch every single time. Unbounded growth in
   * otp_details for exactly the users who can never log in.
   */
  const auth = install();
  await auth.createLoginOtp(STATIC_EMAIL);
  await auth.createLoginOtp(STATIC_EMAIL);
  await auth.createLoginOtp(STATIC_EMAIL);

  assert.equal(store.length, 1,
    `three requests produced ${store.length} rows — each miss appends another, which is what `
    + 'the reporter saw in production (ids 12269, 12270, … all count=1)');
  assert.equal(store[0].count, 3, 'count must increment — proof the UPDATE branch ran, not INSERT');
  assert.equal(store.filter((r) => r.created_on === null).length, 1,
    'a refreshed row keeps its NULL created_on; this asserts the row IDENTITY survived');
});

/* ─── the normal path must be unharmed ─────────────────────────────────── */

test('a user WITH a mobile still issues and verifies (positive control)', async () => {
  // Without this, "always match" would pass every test above.
  userRow = makeUser('9810833037');
  const auth = install();
  await auth.createLoginOtp(STATIC_EMAIL);
  await auth.createLoginOtp(STATIC_EMAIL);
  assert.equal(store.length, 1, 'still single-row-per-tuple');
  assert.equal(store[0].user_mobile_no, '9810833037');
  assert.equal((await auth.verifyLoginOtp(STATIC_EMAIL, STATIC_OTP)).ok, true);
});

test('the original intent survives: a partial row is NOT hijacked', async () => {
  /*
   * The `=` was defended in a comment as what kept legacy partial rows — rows
   * carrying only an email or only a mobile — out of the auth flow. That
   * protection was never in the operator: <=> still refuses to match a
   * NULL-mobile row against a user who HAS a mobile, because
   * NULL <=> '9810833037' is false. Pinned so the fix cannot be mistaken for
   * "match anything".
   */
  store.push({
    id: 999, otp: 1111, otp_type: 'crm_login', user_email: STATIC_EMAIL,
    user_mobile_no: null, generated_on: new Date(0), valid_up_to: new Date(0),
    is_expired: 0, count: 7, created_on: null,
  });
  userRow = makeUser('9810833037');
  const auth = install();
  await auth.createLoginOtp(STATIC_EMAIL);

  assert.equal(store.length, 2, 'the mobile user must get its OWN row, not adopt the partial one');
  assert.equal(store.find((r) => r.id === 999).count, 7, 'the partial row must be untouched');
});

/* ─── the backlog the bug already created ──────────────────────────────── */

test('with duplicate rows already present, verify uses the NEWEST', async () => {
  /*
   * Fixing the match alone was not enough. Affected users already hold a pile
   * of rows, and `LIMIT 1` without ORDER BY lets MySQL return any of them — so
   * the lockout would have become an equally unloggable OTP_MISMATCH against a
   * stale code. This asserts the ordering that makes the fix hold on the data
   * the bug left behind.
   */
  const stale = {
    id: 12269, otp: 7291, otp_type: 'crm_login', user_email: STATIC_EMAIL,
    user_mobile_no: null, generated_on: new Date('2026-09-10T13:51:47Z'),
    valid_up_to: new Date('2026-09-10T13:56:47Z'), is_expired: 0, count: 1, created_on: null,
  };
  const fresh = {
    ...stale, id: 12270, otp: STATIC_OTP,
    generated_on: new Date('2026-09-10T13:52:10Z'),
    valid_up_to: new Date(Date.now() + 5 * 60_000),
  };
  store.push(stale, fresh);
  const auth = install();

  const out = await auth.verifyLoginOtp(STATIC_EMAIL, STATIC_OTP);
  assert.equal(out.ok, true,
    `verify picked the wrong row (reason=${out.reason}); with a backlog present it must take the `
    + 'newest by generated_on, or the fix trades NO_OTP_ISSUED for OTP_MISMATCH');
});
