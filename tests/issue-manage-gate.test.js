/*
 * WHO MAY TRIAGE the issue queue — the TWO-LOCK gate in
 * services/issue.service.js `resolveActor`.
 *
 *   canManage  ⟺  holds the isIssueManage action key
 *                 AND official_email ∈ easyfix_properties['access.issues.emails']
 *
 * Both halves matter and the AND is the point. A test that only checked the
 * happy path would pass identically against a gate that had dropped either
 * lock, so every case below flips exactly ONE input away from the allowed
 * actor and asserts the answer changes.
 *
 * WHY resolveActor AND NOT A ROUTE. resolveActor is the single place canManage
 * is defined; listIssues, loadIssueForActor and closeIssue all consume it. A
 * test through HTTP would prove one route is wired and only incidentally prove
 * the rule — and the rule is what a future endpoint added to routes/admin/
 * issues.js will inherit.
 *
 * ─── THE POSITIVE CONTROL ─────────────────────────────────────────────────
 *
 * Every DENY here is `canManage === false`, and false is also what a broken
 * fixture produces: an allowlist that never loaded, a property row the fake
 * pool did not answer, a typo'd key. All of those make every deny-test pass,
 * for the wrong reason, in the direction of the hypothesis.
 *
 * `the allowed actor passes both locks` is the control. It runs the SAME
 * property cache and the SAME key through the SAME function and asserts TRUE.
 * If the allowlist ever stops loading, that test fails first and names the
 * real problem instead of leaving five green denials behind it.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const ALLOWED_EMAIL = 'priyanka@easyfix.in';
const OTHER_EMAIL = 'someone.else@easyfix.in';
const MANAGE_ACTION = 'isIssueManage';

/*
 * The property row the gate reads. Mixed case and stray spaces on purpose:
 * parseEmailAllowlist lowercases and trims, and an operator editing a CSV by
 * hand in a DB client produces exactly this.
 */
const ALLOWLIST_CSV = ' Sundeep@easyfix.in , PRIYANKA@easyfix.in ,harkirpa@easyfix.in';

const routes = [
  [/SELECT property_key, property_value FROM easyfix_properties/, () => [
    { property_key: 'access.issues.emails', property_value: ALLOWLIST_CSV },
  ]],
];

let svc;
let properties;

before(async () => {
  // Install BEFORE requiring anything that captures `pool` at require time.
  installFakePool(routes);
  properties = require('../services/properties.service');
  // Populate the cache synchronously for the whole file. getProperty() is
  // deliberately non-async and returns undefined on a cold cache, which would
  // deny everyone — including the control — and look exactly like the gate
  // working.
  await properties.preload();
  svc = require('../services/issue.service');
});

/** A request as the auth middleware leaves it: permissions already hydrated,
 *  so resolveActor never reaches role.service. */
function req({ email, actions }) {
  return {
    user: {
      user_id: 41,
      official_email: email,
      permissions: { actionPermissions: actions },
    },
  };
}

// ─── THE CONTROL ─────────────────────────────────────────────────────────
test('the allowed actor passes both locks', async () => {
  const actor = await svc.resolveActor(req({ email: ALLOWED_EMAIL, actions: [MANAGE_ACTION] }));
  assert.equal(actor.canManage, true, 'key + allowlisted email must manage');
  assert.equal(actor.userId, 41);
});

// ─── ONE LOCK MISSING, EITHER WAY ────────────────────────────────────────
test('the action key WITHOUT an allowlisted email does not manage', async () => {
  const actor = await svc.resolveActor(req({ email: OTHER_EMAIL, actions: [MANAGE_ACTION] }));
  assert.equal(actor.canManage, false, 'RBAC alone must not open the queue');
});

test('an allowlisted email WITHOUT the action key does not manage', async () => {
  const actor = await svc.resolveActor(req({ email: ALLOWED_EMAIL, actions: [] }));
  assert.equal(actor.canManage, false, 'the allowlist alone must not open the queue');
});

// ─── FAIL-CLOSED EDGES ───────────────────────────────────────────────────
test('a user row with no official_email does not manage', async () => {
  for (const email of [null, undefined, '']) {
    const actor = await svc.resolveActor(req({ email, actions: [MANAGE_ACTION] }));
    assert.equal(actor.canManage, false, `email=${JSON.stringify(email)} must deny`);
  }
});

test('case and surrounding spaces in the CSV do not change the answer', async () => {
  // 'Sundeep@easyfix.in' is stored capitalised and padded; the caller arrives
  // lowercase. Matching must succeed, or an operator's harmless formatting
  // silently revokes someone's access.
  const actor = await svc.resolveActor(req({ email: 'sundeep@easyfix.in', actions: [MANAGE_ACTION] }));
  assert.equal(actor.canManage, true);
});

test('an unauthenticated request is refused before either lock is consulted', async () => {
  await assert.rejects(
    () => svc.resolveActor({ user: null }),
    (e) => e.status === 401,
    'no user must be a 401, not a silent canManage=false',
  );
});
