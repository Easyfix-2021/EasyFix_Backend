/*
 * "Pending on you" must not become "pending on somebody else".
 *
 * GET /api/client/permission-requests answers a question no per-job route can:
 * WHICH of this client's jobs are waiting on a permit. That makes it the first
 * permission-request read that is not addressed by a job id — and therefore the
 * first one whose scope is not established by loadJobInScope, the resolver
 * every other client route leans on.
 *
 * Two checks decide who may see a row, and they are NOT interchangeable:
 *
 *   tenancy    j.fk_client_id = <the caller's client>
 *   hierarchy  j.reporting_contact_id IN <the caller's subtree>
 *
 * Tenancy alone is the tempting shortcut and it is wrong: a SPOC low in a
 * client's tree would see every sibling's jobs, which is exactly the leak the
 * per-job route spends a hierarchy lookup to prevent. hierarchyFilter() returns
 * `undefined` for a top-level or allStores caller — legitimately the whole
 * client — and an ARRAY otherwise.
 *
 * The empty array is the case worth a test of its own. "Restricted to nobody"
 * must return nothing, and it cannot be expressed as `IN ()` (invalid SQL);
 * the failure mode if that guard is ever dropped is not an error but the widest
 * possible answer, because the clause disappears and tenancy alone remains.
 *
 * No DB: the fake pool records the statement and its params, which is precisely
 * what is under test here — the shape of the WHERE clause, not the rows.
 *
 *   node --test --test-force-exit tests/permission-requests-client-scope.test.js
 */
process.env.NOTIFICATIONS_DISABLE = 'true';
process.env.S3_BUCKET_NAME = '';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* One canned row so toItem() has something to map; the document is absent, so
 * no storage call is reachable from here. */
const ROW = {
  id: 11,
  job_id: 5001,
  requested_by_efr_id: 42,
  kind: 'Mall Gate Pass',
  note: 'Night work, 10pm-9am window',
  status: 'requested',
  document_image_id: null,
  fulfilled_by_contact_id: null,
  decline_reason: null,
  requested_on: '2026-09-09 11:00:00',
  resolved_on: null,
  requested_by_name: 'Priyanka Gupta',
  job_reference_id: 'PPZ-9958',
  client_ref_id: 'CR-1',
  city_name: 'Ahmedabad',
  category_name: 'Electrical',
};

/* installFakePool swaps the methods on the shared db.pool singleton itself, so
 * this MUST run before the service is required — the service captures `pool`
 * at require time. */
const fake = installFakePool([[/FROM tbl_job_permission_request pr/i, () => [ROW]]]);

const permissionRequests = require('../services/job-permission-request.service');

/** The one statement the service issued, and its bind list. */
function lastSelect() {
  const call = fake.calls.filter((c) => /FROM tbl_job_permission_request pr/i.test(c.sql)).pop();
  return call || { sql: '', params: [] };
}

beforeEach(() => { fake.calls.length = 0; });

test('a hierarchy-restricted caller is filtered by reporting_contact_id, and binds exactly those ids', async () => {
  const items = await permissionRequests.listForClient({
    clientId: 133, contactIds: [42, 43], status: 'requested', limit: 100,
  });
  const { sql, params } = lastSelect();

  assert.match(sql, /j\.fk_client_id = \?/, 'tenancy is not optional');
  assert.match(sql, /j\.reporting_contact_id IN \(\?\)/,
    'a restricted caller MUST carry the hierarchy clause — tenancy alone shows every sibling');
  assert.deepEqual(params, ['requested', 133, [42, 43], 100]);
  assert.equal(items.length, 1);
  assert.equal(items[0].jobId, 5001);
});

test('a top-level / allStores caller (undefined) sees the whole client and no IN clause is emitted', async () => {
  await permissionRequests.listForClient({ clientId: 133, contactIds: undefined });
  const { sql, params } = lastSelect();

  assert.match(sql, /j\.fk_client_id = \?/, 'tenancy still applies to a top-level caller');
  assert.ok(!/reporting_contact_id/.test(sql),
    'undefined means unrestricted WITHIN the client, so no hierarchy clause belongs here');
  assert.deepEqual(params, ['requested', 133, 100]);
});

test('a caller scoped to NOBODY gets nothing, and never reaches SQL', async () => {
  /*
   * The dangerous one. If this guard is dropped, `contactIds: []` does not
   * error — the clause is simply omitted and the caller is handed the entire
   * client. Asserting "no query ran" is what distinguishes an empty result from
   * a silently widened one; asserting only `items.length === 0` would pass in
   * both worlds if the fake happened to return nothing.
   */
  const items = await permissionRequests.listForClient({ clientId: 133, contactIds: [] });

  assert.deepEqual(items, []);
  assert.equal(
    fake.calls.filter((c) => /tbl_job_permission_request/i.test(c.sql)).length,
    0,
    'an empty scope must short-circuit; reaching SQL at all means the IN clause was dropped',
  );
});

test('the job context rides along so a row is actionable without opening the job', async () => {
  const [item] = await permissionRequests.listForClient({ clientId: 133, contactIds: [42] });

  assert.equal(item.reference, 'PPZ-9958');
  assert.equal(item.city, 'Ahmedabad');
  assert.equal(item.category, 'Electrical');
  // …without disturbing the shape toItem() owns.
  assert.equal(item.kind, 'Mall Gate Pass');
  assert.equal(item.status, 'requested');
  assert.equal(item.documentKind, null, 'no document on an open request');
});

test('limit is bounded rather than trusted', async () => {
  await permissionRequests.listForClient({ clientId: 133, contactIds: [42], limit: 100000 });
  assert.equal(lastSelect().params.at(-1), 200, 'an unbounded LIMIT is a client-supplied table scan');

  fake.calls.length = 0;
  await permissionRequests.listForClient({ clientId: 133, contactIds: [42], limit: 0 });
  assert.equal(lastSelect().params.at(-1), 100, 'zero falls back to the default, never to no rows');
});

test('oldest first — the panel claims someone is waiting, so the longest wait leads', async () => {
  await permissionRequests.listForClient({ clientId: 133, contactIds: [42] });
  assert.match(lastSelect().sql, /ORDER BY pr\.requested_on ASC/);
});

console.log('permission-requests client scope: tenancy, hierarchy, empty-scope, bounds');
