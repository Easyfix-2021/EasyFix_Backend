/*
 * DELETE /api/mobile/jobs/:id/images/:imageId — the technician removing a wrong
 * before/after photo.
 *
 * This is the one mobile route that DESTROYS evidence, so the whole test is
 * about what it must REFUSE. Three guards, and each is asserted in both
 * directions, because a guard that only ever refuses is as broken as one that
 * only ever allows:
 *
 *   OWNERSHIP  another technician's job is a 404, not a 403 — a 403 would
 *              confirm the job exists.
 *   STATUS     a CLOSED allowlist (2 IN_PROGRESS, 15 ESTIMATE_PENDING_APPROVAL).
 *              Completed / revisit / pending-to-close / cancelled all refuse:
 *              deleting proof off a job billing has already read is the
 *              irreversible mistake this route exists to avoid.
 *   CATEGORY   only the before/after PROOF buckets. tbl_job_image is ONE table
 *              holding Purchase Orders, Job Sheets, the customer's feedback PDF
 *              and the customer's signature, and an image_id is just an integer
 *              — without the allowlist "delete my photo" is "delete any row on
 *              this job", and a mistyped id removes a signed document.
 *
 * The category guard is asserted at the SQL, not only at the response: the
 * allowlist is what the shared deleteJobImage() puts into the WHERE clause, and
 * a route that returned 404 while still having issued the DELETE would pass a
 * response-only test.
 *
 * Runner: `node --test --test-force-exit tests/mobile-job-image-delete.test.js`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');

const TECH = 7;
const JOB_ID = 42;

// Rows the fake pool serves. `jobRow` is swapped per test to move the status.
let jobRow = { job_id: JOB_ID, fk_client_id: 3, fk_easyfixter_id: TECH, job_status: 2 };
// The tbl_job_image row the SELECT finds — null models "no row matched the
// guarded WHERE", which is how a wrong category and a wrong job both look.
let imageRow = { image_id: 900, job_id: JOB_ID, image: 'JobSupportings/checkout_42_1', image_category: 'checkout' };

const fake = installFakePool([
  [/FROM tbl_job\b/i, () => (jobRow ? [jobRow] : [])],
  [/FROM tbl_job_image/i, (sql, params) => {
    // Model the real guarded SELECT: the row comes back only if the category
    // the caller allowed actually contains this row's category, and only if the
    // job_id matches. Anything else is "no such deletable photo".
    if (!imageRow) return [];
    const lowered = params.map((p) => String(p).toLowerCase());
    if (/AND job_id = \?/.test(sql) && Number(params[1]) !== Number(imageRow.job_id)) return [];
    if (/image_category\) IN/i.test(sql) && !lowered.includes(String(imageRow.image_category).toLowerCase())) return [];
    return [imageRow];
  }],
]);

require.cache[require.resolve('../middleware/tech-auth')] = {
  id: require.resolve('../middleware/tech-auth'),
  filename: require.resolve('../middleware/tech-auth'),
  loaded: true,
  exports: (req, _res, next) => { req.tech = { efr_id: TECH, user_id: 55 }; next(); },
};
require.cache[require.resolve('../middleware/require-tech-lifecycle-capability')] = {
  id: require.resolve('../middleware/require-tech-lifecycle-capability'),
  filename: require.resolve('../middleware/require-tech-lifecycle-capability'),
  loaded: true,
  exports: {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  },
};

// S3 is not under test and must not be reached — stub it before the image
// service captures it. A real deleteObject here would be a network call.
require.cache[require.resolve('../utils/s3-storage')] = {
  id: require.resolve('../utils/s3-storage'),
  filename: require.resolve('../utils/s3-storage'),
  loaded: true,
  exports: { deleteObject: async () => {} },
};

let server;
let baseUrl;

before(async () => {
  // eslint-disable-next-line global-require
  const router = require('../routes/mobile/jobs-estimate');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tech = { efr_id: TECH, user_id: 55 }; next(); });
  app.use('/jobs', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fake.restore) fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  jobRow = { job_id: JOB_ID, fk_client_id: 3, fk_easyfixter_id: TECH, job_status: 2 };
  imageRow = { image_id: 900, job_id: JOB_ID, image: 'JobSupportings/checkout_42_1', image_category: 'checkout' };
});

async function del(jobId = JOB_ID, imageId = 900, method = 'DELETE') {
  const r = await fetch(`${baseUrl}/jobs/${jobId}/images/${imageId}`, { method });
  return { status: r.status, body: await r.json() };
}

/** Did a DELETE statement actually reach the database? */
const deleteIssued = () => fake.calls.some((c) => /^\s*DELETE FROM tbl_job_image/i.test(c.sql));

// ─── The happy path ──────────────────────────────────────────────────

test('a work photo on the tech\'s own in-progress job is removed', async () => {
  const res = await del();
  assert.equal(res.status, 200);
  assert.equal(res.body?.data?.imageId, 900);
  assert.equal(res.body?.data?.category, 'checkout');
  assert.ok(deleteIssued(), 'the row must actually be deleted');
});

test('POST is the same handler — the RN client has no delete() verb', async () => {
  const res = await del(JOB_ID, 900, 'POST');
  assert.equal(res.status, 200, 'POST /:id/images/:imageId must behave as DELETE');
  assert.ok(deleteIssued());
});

test('an estimate awaiting approval (15) can still delete — same window as capture', async () => {
  jobRow = { ...jobRow, job_status: 15 };
  const res = await del();
  assert.equal(res.status, 200);
});

// ─── Ownership ───────────────────────────────────────────────────────

test('another technician\'s job is a 404, and nothing is deleted', async () => {
  jobRow = { ...jobRow, fk_easyfixter_id: 999 };
  const res = await del();
  assert.equal(res.status, 404);
  assert.ok(!deleteIssued(), 'ownership is checked before any write');
});

test('a job that does not exist is the same 404', async () => {
  jobRow = null;
  const res = await del();
  assert.equal(res.status, 404);
  assert.ok(!deleteIssued());
});

// ─── Status gate ─────────────────────────────────────────────────────

for (const [status, name] of [
  [0, 'BOOKED'], [1, 'SCHEDULED'], [3, 'COMPLETED'], [5, 'COMPLETED_ALT'],
  [6, 'CANCELLED'], [10, 'REVISIT'], [20, 'PENDING_TO_CLOSE'],
]) {
  test(`status ${status} ${name} refuses the delete, and writes nothing`, async () => {
    jobRow = { ...jobRow, job_status: status };
    const res = await del();
    assert.equal(res.status, 409, `${name} must not be deletable`);
    assert.ok(!deleteIssued(), `${name} must not reach the DELETE`);
  });
}

test('a status this backend gains later is refused, not allowed', async () => {
  // The allowlist is CLOSED on purpose: the safe default for an irreversible
  // action is "no" until somebody decides otherwise.
  jobRow = { ...jobRow, job_status: 21 };
  const res = await del();
  assert.equal(res.status, 409);
});

// ─── Category allowlist ──────────────────────────────────────────────

test('the allowlist reaching SQL is the proof buckets and NOTHING else', async () => {
  await del();
  const select = fake.calls.find((c) => /FROM tbl_job_image/i.test(c.sql));
  assert.ok(select, 'the guarded SELECT must run');
  const allowed = select.params.slice(2).map((p) => String(p).toLowerCase());
  assert.deepEqual(
    [...allowed].sort(),
    ['after', 'before', 'booking', 'checkin', 'checkout', 'completion', 'unconfirmed'],
    'exactly the before/after proof categories',
  );
  for (const document of ['po', 'jobsheet', 'feedback', 'questionaire', 'customer signature']) {
    assert.ok(!allowed.includes(document), `${document} must never be deletable through the mobile route`);
  }
});

test('a Purchase Order on the same job is a 404, not a deletion', async () => {
  imageRow = { image_id: 901, job_id: JOB_ID, image: 'JobSupportings/po_42_1.pdf', image_category: 'po' };
  const res = await del(JOB_ID, 901);
  assert.equal(res.status, 404);
  assert.ok(!deleteIssued(), 'a document row must survive');
});

test('the customer signature is a 404, not a deletion', async () => {
  imageRow = { image_id: 902, job_id: JOB_ID, image: 'JobSupportings/sig_42', image_category: 'customer signature' };
  const res = await del(JOB_ID, 902);
  assert.equal(res.status, 404);
  assert.ok(!deleteIssued());
});

test('an image id belonging to ANOTHER job cannot be deleted through this job', async () => {
  imageRow = { image_id: 903, job_id: 4242, image: 'JobSupportings/checkout_4242_1', image_category: 'checkout' };
  const res = await del(JOB_ID, 903);
  assert.equal(res.status, 404);
  assert.ok(!deleteIssued());
});

test('a not-found photo and a not-deletable one answer the SAME 404', async () => {
  // Distinguishing them would confirm that a document row with that id exists.
  imageRow = null;
  const missing = await del(JOB_ID, 904);
  imageRow = { image_id: 905, job_id: JOB_ID, image: 'x', image_category: 'jobsheet' };
  const forbidden = await del(JOB_ID, 905);
  assert.equal(missing.status, forbidden.status);
  assert.deepEqual(missing.body, forbidden.body);
});

// ─── Input validation ────────────────────────────────────────────────

test('a non-numeric image id never reaches the service', async () => {
  const r = await fetch(`${baseUrl}/jobs/${JOB_ID}/images/abc`, { method: 'DELETE' });
  assert.equal(r.status, 400);
  assert.ok(!deleteIssued());
});
