/*
 * Site-access permission requests — the two rules that are not obvious from
 * reading the handlers, and that nothing else in the suite would catch.
 *
 *   1. IDEMPOTENCY. A technician tapping "Request" twice must get the SAME
 *      request back, not a second one. The DB's UNIQUE index on the generated
 *      open_dedupe_key is the guarantee for the racing case, but a unit test
 *      cannot see a real index — what it CAN prove is the half that runs in
 *      this process: the second POST must not reach an INSERT at all.
 *
 *   2. SCOPE. The technician half is assignment-scoped; the client half rides
 *      the ONE client scope resolver (loadJobInScope — tenancy AND reporting
 *      hierarchy). A request is addressed by its own id, not the job's, so it
 *      escapes the `/jobs/:id` regex in client-write-scope.test.js's
 *      completeness check — which means these two routes are covered HERE or
 *      nowhere.
 *
 * No DB: installFakePool dispatches each statement to a canned result, exactly
 * as the neighbouring route tests do. Notifications are suppressed by env, and
 * the push path finds no device tokens through the fake, so nothing leaves the
 * process.
 */
process.env.NOTIFICATIONS_DISABLE = 'true';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* The caller is efr 42 / SPOC 42 of client 133; job 5001 is theirs. */
let jobRow = null;
let openRequest = null;                    // what findOpen() sees
let storedRequest = null;                  // what rowById() sees
let me = { manager_id: 7 };                // not top of tree → hierarchy applies
let subtree = [{ id: 42 }, { id: 43 }];

const fake = installFakePool([
  // Column-presence probes inside job.service.getById. [] = "column absent".
  [/INFORMATION_SCHEMA/i, []],
  [/SELECT manager_id FROM tbl_client_contacts/i, () => [me]],
  [/WITH RECURSIVE team/i, () => subtree],

  // ── tbl_job_permission_request ─────────────────────────────────────
  // Order matters: the fake dispatches on FIRST match, and rowById's
  // `WHERE id = ? LIMIT 1` must not be shadowed by findOpen's pattern.
  [/FROM tbl_job_permission_request\s+WHERE job_id = \? ORDER BY id DESC/i, () => (storedRequest ? [storedRequest] : [])],
  [/FROM tbl_job_permission_request\s+WHERE id = \? LIMIT 1/i, () => (storedRequest ? [storedRequest] : [])],
  [/FROM tbl_job_permission_request[\s\S]*AND status = \?/i, () => (openRequest ? [openRequest] : [])],
  [/SELECT id, job_id, status FROM tbl_job_permission_request/i, () => (storedRequest ? [storedRequest] : [])],
  [/INSERT INTO tbl_job_permission_request/i, () => ({ insertId: 77 })],
  [/UPDATE tbl_job_permission_request/i, () => ({ affectedRows: 1 })],

  // The job itself — job.service.getById's projection.
  [/^\s*SELECT j\.\*/i, () => (jobRow ? [jobRow] : [])],
]);

const mobileRouter = require('../routes/mobile/permission-requests');
const clientRouter = require('../routes/client/index');

function handlerFor(router, path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  return layer.route;
}

const res = () => ({
  statusCode: null, body: null, locals: {},
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

/*
 * Run a route's WHOLE stack (validators included), so a schema that rejects the
 * fixture shows up as a test failure rather than as a handler that never ran.
 */
async function run(router, path, method, req) {
  const route = handlerFor(router, path, method);
  const r = res();
  req.locals = req.locals || {};
  for (const layer of route.stack) {
    let advanced = false;
    // eslint-disable-next-line no-await-in-loop
    await layer.handle(req, r, (e) => { if (e) throw e; advanced = true; });
    if (!advanced) break;                  // this layer answered — stop here
  }
  return r;
}

const techReq = (over = {}) => ({
  tech: { efr_id: 42, efr_name: 'Ravi' },
  // originalUrl: middleware/validate reads it to pick the error envelope, so a
  // request without one crashes the VALIDATOR rather than failing the assertion.
  method: 'POST', originalUrl: '/api/mobile/jobs/5001/permission-requests',
  params: { jobId: '5001' }, query: {}, body: {}, ...over,
});
const spocReq = (over = {}) => ({
  spoc: { id: 42, client_id: 133, contact_name: 'Caller' },
  access: { allStores: false },
  method: 'POST', originalUrl: '/api/client/permission-requests/77/decline',
  params: { id: '77' }, query: {}, body: {}, ...over,
});
const job = (over = {}) => ({
  job_id: 5001, fk_client_id: 133, fk_easyfixter_id: 42,
  reporting_contact_id: 43, client_ref_id: 'REF-1', ...over,
});
const request = (over = {}) => ({
  id: 77, job_id: 5001, requested_by_efr_id: 42, kind: 'Mall Gate Pass',
  note: null, status: 'requested', document_image_id: null,
  fulfilled_by_contact_id: null, decline_reason: null,
  requested_on: '2026-09-07 10:00:00', resolved_on: null, ...over,
});

const inserted = () => fake.calls.filter((c) => /INSERT INTO tbl_job_permission_request/i.test(c.sql)).length;
const updated  = () => fake.calls.some((c) => /UPDATE tbl_job_permission_request/i.test(c.sql));

beforeEach(() => {
  fake.reset();
  jobRow = job();
  openRequest = null;
  storedRequest = request();
  me = { manager_id: 7 };
  subtree = [{ id: 42 }, { id: 43 }];
});

/* ─── 1. THE IDEMPOTENCY RULE ─────────────────────────────────────────── */

test('a first Request inserts exactly one row', async () => {
  const r = await run(mobileRouter, '/:jobId/permission-requests', 'post',
    techReq({ body: { kind: 'Mall Gate Pass' } }));
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.data.id, 77);
  assert.equal(r.body.data.status, 'requested');
  assert.equal(inserted(), 1);
});

test('tapping Request again returns the SAME request and inserts nothing', async () => {
  openRequest = request({ id: 61 });                 // one is already open
  const r = await run(mobileRouter, '/:jobId/permission-requests', 'post',
    techReq({ body: { kind: 'Mall Gate Pass' } }));

  assert.equal(r.body.data.id, 61, 'the caller must get the existing request back');
  assert.equal(inserted(), 0,
    'a second tap that reaches an INSERT is how a client ends up with two identical '
    + 'cards, one of which can never be closed');
});

test('the dedupe ignores casing and stray whitespace in `kind`', async () => {
  openRequest = request({ id: 61 });
  await run(mobileRouter, '/:jobId/permission-requests', 'post',
    techReq({ body: { kind: '  mall   gate pass ' } }));

  const probe = fake.calls.find((c) => /AND status = \?/i.test(c.sql));
  assert.ok(probe, 'the open-request probe must run before any insert');
  assert.equal(probe.params[1], 'mall gate pass',
    'the probe must compare the canonical form, or "Mall Gate Pass" and '
    + '"mall  gate pass" become two open requests for one gate');
  assert.equal(inserted(), 0);
});

test('a DIFFERENT kind on the same job is a new request', async () => {
  openRequest = null;                                // nothing open for THIS kind
  const r = await run(mobileRouter, '/:jobId/permission-requests', 'post',
    techReq({ body: { kind: 'Society NOC' } }));
  assert.equal(r.statusCode, 201);
  assert.equal(inserted(), 1, 'the rule is per job AND kind, not per job');
});

/* ─── 2. SCOPE — the technician half ──────────────────────────────────── */

test("a job assigned to someone else is 404, and nothing is inserted", async () => {
  jobRow = job({ fk_easyfixter_id: 99 });
  const r = await run(mobileRouter, '/:jobId/permission-requests', 'post',
    techReq({ body: { kind: 'Mall Gate Pass' } }));
  assert.equal(r.statusCode, 404);
  assert.equal(inserted(), 0, 'the refusal must come BEFORE the write');
});

test('an OFFERED-but-not-accepted job is also 404', async () => {
  // GET /jobs/:id lets an offered technician read a job to decide on it. Nobody
  // is standing at a gate for a job they have not taken, so this is stricter.
  jobRow = job({ fk_easyfixter_id: null });
  const r = await run(mobileRouter, '/:jobId/permission-requests', 'get', techReq());
  assert.equal(r.statusCode, 404);
});

/* ─── 3. SCOPE — the client half ──────────────────────────────────────── */

test("another client's request cannot be fulfilled", async () => {
  jobRow = job({ fk_client_id: 999 });
  const r = await run(clientRouter, '/permission-requests/:id/decline', 'post',
    spocReq({ body: { reason: 'not our building' } }));
  assert.equal(r.statusCode, 404, 'cross-tenant is the check that must never weaken');
  assert.equal(updated(), false);
});

test("a peer's job inside the same client is 404 for a scoped SPOC", async () => {
  jobRow = job({ reporting_contact_id: 99 });        // same client, outside the subtree
  const r = await run(clientRouter, '/permission-requests/:id/decline', 'post',
    spocReq({ body: { reason: 'not our tower' } }));
  assert.equal(r.statusCode, 404,
    'tenancy alone would let any SPOC answer a colleague\'s request by guessing its id');
  assert.equal(updated(), false);
});

test('a SPOC inside the subtree CAN decline, and the reason is stored', async () => {
  storedRequest = request();
  const r = await run(clientRouter, '/permission-requests/:id/decline', 'post',
    spocReq({ body: { reason: 'the mall needs 48h notice' } }));
  assert.equal(r.statusCode, null, 'a successful modernOk leaves the default 200');
  assert.equal(updated(), true);
  const write = fake.calls.find((c) => /UPDATE tbl_job_permission_request/i.test(c.sql));
  assert.equal(write.params[0], 'declined');
  assert.equal(write.params[1], 'the mall needs 48h notice');
});

test('an already-answered request is 409, not a silent overwrite', async () => {
  storedRequest = request({ status: 'fulfilled' });
  const r = await run(clientRouter, '/permission-requests/:id/decline', 'post',
    spocReq({ body: { reason: 'changed my mind' } }));
  assert.equal(r.statusCode, 409);
  assert.equal(updated(), false);
});

/* ─── 4. THE WIRE SHAPE THREE OTHER FRONTENDS ARE CODED AGAINST ───────── */

test('a list item carries exactly the contracted keys', async () => {
  storedRequest = request();
  const r = await run(mobileRouter, '/:jobId/permission-requests', 'get', techReq());
  const [item] = r.body.data.items;
  for (const k of ['id', 'kind', 'note', 'status', 'requestedAt', 'fulfilledAt', 'documentUrl']) {
    assert.ok(k in item, `the contract's \`${k}\` is missing — a frontend reads it`);
  }
  assert.equal(item.documentUrl, null,
    'an unfulfilled request has no document; null is the contracted empty value');
});
