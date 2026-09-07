/*
 * The customer PIN is the CLOSING control (2026-09-07).
 *
 * Product rule: "treat the Start PIN as job close pin. Its not mandatory to
 * start the job but is mandatory to close it. To start job, only the location
 * and selfie is required."
 *
 * So POST /api/mobile/jobs/:id/checkout now requires the PIN and verifies it
 * against tbl_job.otp, returning 409 INVALID_CHECKOUT_PIN when it is missing or
 * wrong. Two things must NOT regress and are pinned here:
 *   - a job whose row carries NO PIN stays closable (most old jobs never went
 *     through the BOOKED-confirm path that mints one);
 *   - the gate is MOBILE-ONLY. The CRM completes through
 *     PATCH /api/admin/jobs/:id/status → job.setStatus(), so ops can always
 *     close a job the technician could not.
 *
 * The check-in side (PIN no longer blocks starting) is pinned in
 * tests/mobile-checkin-nondestructive.test.js.
 *
 * Runner: `node --test --test-force-exit tests/mobile-close-pin.test.js`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');

// Never touch a DB: patch the shared pool singleton BEFORE the router (and the
// services it pulls in) capture their `pool` reference.
const fake = installFakePool([]);

// Auth / capability / idempotency layers are not under test — seed
// require.cache with pass-throughs before the router asks for them.
require.cache[require.resolve('../middleware/tech-auth')] = {
  id: require.resolve('../middleware/tech-auth'),
  filename: require.resolve('../middleware/tech-auth'),
  loaded: true,
  exports: (req, _res, next) => { req.tech = { efr_id: 7 }; next(); },
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
require.cache[require.resolve('../middleware/idempotency')] = {
  id: require.resolve('../middleware/idempotency'),
  filename: require.resolve('../middleware/idempotency'),
  loaded: true,
  exports: () => (_req, _res, next) => next(),
};

const jobService = require('../services/job.service');

const JOB = { job_id: 42, fk_easyfixter_id: 7, job_status: 2, otp: '1234' };

let captured = null;
let server;
let baseUrl;

const originalGetById = jobService.getById;
const originalSetStatus = jobService.setStatus;

before(async () => {
  jobService.getById = async () => ({ ...JOB });
  jobService.setStatus = async (jobId, payload) => {
    captured = { jobId, ...payload };
    return { updated: true };
  };

  // eslint-disable-next-line global-require
  const router = require('../routes/mobile/index');
  const app = express();
  app.use(express.json());
  app.use('/mobile', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  jobService.getById = originalGetById;
  jobService.setStatus = originalSetStatus;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fake.restore) fake.restore();
});

beforeEach(() => { captured = null; });

async function checkout(body) {
  const r = await fetch(`${baseUrl}/mobile/jobs/42/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ─── The gate ────────────────────────────────────────────────────────

test('closing WITHOUT the PIN is rejected before any write', async () => {
  const res = await checkout({});
  assert.equal(res.status, 409, 'the PIN is mandatory to close');
  assert.equal(res.body?.error?.code, 'INVALID_CHECKOUT_PIN');
  assert.equal(captured, null, 'no status write may happen on a PIN failure');
});

test('closing with the WRONG PIN is rejected before any write', async () => {
  const res = await checkout({ otp: '9999' });
  assert.equal(res.status, 409);
  assert.equal(res.body?.error?.code, 'INVALID_CHECKOUT_PIN');
  assert.match(res.body?.error?.message, /Incorrect/, 'wrong ≠ missing in the human sentence');
  assert.equal(captured, null);
});

test('the missing-PIN message differs from the wrong-PIN one, under one code', async () => {
  // One code because the app does the same thing either way (prompt + Resend);
  // two sentences because the technician needs to know which it was.
  const missing = await checkout({});
  const wrong = await checkout({ otp: '9999' });
  assert.equal(missing.body?.error?.code, wrong.body?.error?.code);
  assert.notEqual(missing.body?.error?.message, wrong.body?.error?.message);
});

// ─── The happy path ──────────────────────────────────────────────────

test('the right PIN closes the job — trimmed, like the check-in compare', async () => {
  const res = await checkout({ otp: ' 1234 ' });
  assert.equal(res.status, 200);
  assert.equal(captured.status, 3, 'transition to COMPLETED is unchanged');
});

test('a revisit close is gated the same way and still routes to REVISIT', async () => {
  const blocked = await checkout({ isNextVisit: true });
  assert.equal(blocked.status, 409, 'a revisit is still a close');
  const ok = await checkout({ otp: '1234', isNextVisit: true });
  assert.equal(ok.status, 200);
  assert.equal(captured.status, 10, 'REVISIT, not COMPLETED');
});

// ─── The regression that would strand every old job ──────────────────

test('a job with NO PIN on the row is still closable', async () => {
  // Most jobs predate the PIN, or never went through the BOOKED-confirm path
  // that mints one. Enforcing unconditionally makes them uncloseable forever.
  jobService.getById = async () => ({ ...JOB, otp: null });
  const res = await checkout({});
  assert.equal(res.status, 200, 'no PIN on the row → no PIN to demand');
  assert.equal(captured.status, 3);
  jobService.getById = async () => ({ ...JOB });
});

test('an empty-string PIN on the row counts as no PIN, not as a PIN of ""', async () => {
  jobService.getById = async () => ({ ...JOB, otp: '   ' });
  const res = await checkout({});
  assert.equal(res.status, 200);
  jobService.getById = async () => ({ ...JOB });
});

// ─── CRM safety: the gate must never migrate into the shared service ─

test('the closing-PIN gate lives in the mobile route ONLY', async () => {
  // job.setStatus() is what PATCH /api/admin/jobs/:id/status calls, i.e. how ops
  // completes a job from the CRM. If this gate ever moves into that shared
  // service, a CRM completion starts failing for want of a customer PIN the
  // operator does not have — the exact escape hatch this design depends on.
  const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'job.service.js'), 'utf8');
  assert.ok(!service.includes('INVALID_CHECKOUT_PIN'),
    'the closing-PIN check must not be in job.service.js — it would block CRM completion too');
  const adminJobs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', 'jobs.js'), 'utf8');
  assert.ok(!adminJobs.includes('INVALID_CHECKOUT_PIN'),
    'ops must be able to close a job the technician could not');
});
