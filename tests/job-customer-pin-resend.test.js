/*
 * POST /api/admin/jobs/:id/resend-customer-pin — the ops escape hatch for a
 * technician who cannot get the customer PIN (tbl_job.otp).
 *
 * Six behaviours, six checks:
 *   1. it is RBAC-gated on the exact action key the seed migration creates;
 *   2. a job with NO technician assigned answers 409 with an actionable
 *      sentence and never reaches the SMS service;
 *   3. the happy path passes the JOB'S OWN technician through to
 *      mobileLifecycle.sendCheckinSms (the ownership guard is satisfied by
 *      being true, not skipped) and the response NEVER carries the PIN —
 *      asserted with a service double that deliberately returns one;
 *   4. the per-job limiter actually refuses the 4th attempt in a window;
 *   5. the re-send lands in JOB HISTORY (tbl_job_logs) with the acting
 *      operator on it — an application log line is invisible on the job,
 *      which is where "why couldn't this job close?" is asked;
 *   6. that history write is FAIL-OPEN: the SMS has already gone to the
 *      customer, so a dead log must not 500 the operator into re-sending.
 *
 * Route-layer style follows tests/easyfixer-lifecycle-route-auth.js: pull the
 * layer out of router.stack and drive the middleware directly — no HTTP, no
 * DB. Requiring the router is enough to boot the module graph (mysql2 pools
 * are lazy), but it DOES construct a pool, hence --test-force-exit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../services/mobile-job-lifecycle.service');
const jobLog = require('../services/job-log.service');
const router = require('../routes/admin/jobs');

const PATH = '/:id/resend-customer-pin';

function layer() {
  const found = router.stack.find((entry) => (
    entry.route && entry.route.path === PATH && entry.route.methods.post
  ));
  assert.ok(found, `POST ${PATH} must be mounted on the admin jobs router`);
  return found;
}

/** The chain, in mount order, minus Express's own bookkeeping. */
function chain() {
  return layer().route.stack.map((e) => e.handle);
}

function responseDouble() {
  return {
    locals: {},
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Every (jobId, actor) the route handed to the job-history writer. */
const pinLogCalls = [];

/*
 * Swap in a fake sendCheckinSms for one test; always restore.
 *
 * The job-history writer is stubbed alongside it, ALWAYS — this file drives the
 * handler with no fake pool, and the real writer would open a socket to a
 * database that is not there and sit on the 30-second connect timeout. `logStub`
 * overrides the default recorder for the fail-open test.
 */
async function withSendStub(stub, fn, logStub) {
  const originalSend = lifecycle.sendCheckinSms;
  const originalLog = jobLog.logCustomerPinResent;
  lifecycle.sendCheckinSms = stub;
  pinLogCalls.length = 0;
  jobLog.logCustomerPinResent = logStub
    || (async (...args) => { pinLogCalls.push(args); return 999; });
  try {
    return await fn();
  } finally {
    // Restored in `finally`, not after the asserts: an assertion that throws
    // must not leak the stubs into the next test.
    lifecycle.sendCheckinSms = originalSend;
    jobLog.logCustomerPinResent = originalLog;
  }
}

test('resend-customer-pin is gated on the isJobCustomerPinResend action', async () => {
  const guard = layer().route.stack.find((e) => e.handle.name === 'actionGuard');
  assert.ok(guard, 'route must include a requireAction() guard');

  const denied = responseDouble();
  let deniedNext = false;
  await guard.handle(
    { user: { user_id: 7, permissions: { actionPermissions: [] } } },
    denied,
    () => { deniedNext = true; },
  );
  assert.equal(deniedNext, false);
  assert.equal(denied.statusCode, 403);
  // The exact key the seed migration inserts. If either side is renamed
  // without the other, this fails instead of shipping a dead endpoint.
  assert.equal(denied.body.error, 'Missing permission: isJobCustomerPinResend');

  const allowed = responseDouble();
  let allowedNext = false;
  await guard.handle(
    { user: { user_id: 7, permissions: { actionPermissions: ['isJobCustomerPinResend'] } } },
    allowed,
    () => { allowedNext = true; },
  );
  assert.equal(allowedNext, true);
});

test('no technician assigned → 409, and the SMS service is never called', async () => {
  const handler = chain().at(-1);

  for (const unassigned of [null, 0, undefined]) {
    await withSendStub(
      () => { throw new Error('sendCheckinSms must not be called for an unassigned job'); },
      async () => {
        const res = responseDouble();
        let nextErr = null;
        await handler(
          { params: { id: '4321' }, user: { user_id: 7 }, scopedJob: { fk_easyfixter_id: unassigned } },
          res,
          (e) => { nextErr = e; },
        );
        assert.equal(nextErr, null, 'must answer directly, not fall through to the 500 handler');
        assert.equal(res.statusCode, 409, `fk_easyfixter_id=${unassigned} must be a clean 409`);
        assert.match(res.body.error, /No technician is assigned/);
        assert.equal(res.body.success, false);
      },
    );
  }
});

test('happy path passes the job\'s own technician through and never returns the PIN', async () => {
  const handler = chain().at(-1);
  const seen = [];

  await withSendStub(
    async (jobId, efrId) => {
      seen.push({ jobId, efrId });
      // Deliberately hostile double. The real service returns
      // { sent, channel, delivered }; this adds the PIN under two plausible
      // names because the route must stay PIN-FREE however that file widens its
      // return value — the route owns its own payload, not the service.
      return { sent: true, channel: 'whatsapp', delivered: true, otp: '9137', pin: '9137' };
    },
    async () => {
      const res = responseDouble();
      let nextErr = null;
      await handler(
        { params: { id: '4321' }, user: { user_id: 7 }, scopedJob: { fk_easyfixter_id: 88 } },
        res,
        (e) => { nextErr = e; },
      );

      assert.equal(nextErr, null);
      assert.deepEqual(seen, [{ jobId: 4321, efrId: 88 }],
        'must call the shared service with the job id and the job\'s assigned technician');
      assert.equal(res.statusCode, 200);
      /*
       * The payload widened on 2026-09-09, deliberately. It used to be the
       * literal { sent: true } whatever happened, because the service discarded
       * the provider's answer — and every one of these messages was being
       * REJECTED by DLT while this endpoint reported success, which is how a
       * technician ended up unable to close a job the CRM said had been
       * PIN-ed. It now reports the channel that carried it and whether the
       * provider accepted it.
       */
      assert.deepEqual(res.body.data, { sent: true, channel: 'whatsapp', delivered: true });
      assert.equal(JSON.stringify(res.body).includes('9137'), false,
        'the response must never carry the customer PIN');
    },
  );
});

test('the re-send lands in job history with the acting operator on it', async () => {
  const handler = chain().at(-1);

  await withSendStub(
    async () => ({ sent: true, otp: '9137' }),
    async () => {
      const res = responseDouble();
      await handler(
        { params: { id: '4321' }, user: { user_id: 7 }, scopedJob: { fk_easyfixter_id: 88 } },
        res,
        () => {},
      );
      assert.equal(res.statusCode, 200);
      assert.equal(pinLogCalls.length, 1,
        'a logger.info line is not job history — the question is asked on the JOB');
      const [jobId, actor] = pinLogCalls[0];
      assert.equal(jobId, 4321);
      assert.equal(actor.user_id, 7, 'the row must name who re-sent it');
      // The service double returned a PIN; the route must not have handed it on.
      assert.equal(JSON.stringify(pinLogCalls).includes('9137'), false);
    },
  );
});

test('a dead job history does not 500 an SMS that already went out', async () => {
  // FAIL OPEN. The customer has the code; a 500 here sends ops round again and
  // spends another slot of the 3-per-5-minutes budget for nothing.
  const handler = chain().at(-1);
  let sent = 0;

  await withSendStub(
    async () => { sent += 1; return { sent: true, channel: 'whatsapp', delivered: true }; },
    async () => {
      const res = responseDouble();
      let nextErr = null;
      await handler(
        { params: { id: '4321' }, user: { user_id: 7 }, scopedJob: { fk_easyfixter_id: 88 } },
        res,
        (e) => { nextErr = e; },
      );
      assert.equal(sent, 1, 'the SMS still went out');
      assert.equal(nextErr, null, 'a history failure must not reach the 500 handler');
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.data, { sent: true, channel: 'whatsapp', delivered: true });
    },
    async () => { throw new Error('Table \'tbl_job_logs\' doesn\'t exist'); },
  );
});

test('per-job limiter refuses the 4th attempt inside the window', async () => {
  // The limiter is the middleware before scopedJob; identify it by position
  // rather than by name so a rename of the factory\'s inner fn is not a
  // silent pass.
  const mws = chain();
  const limiter = mws[mws.length - 3];
  assert.equal(typeof limiter, 'function');

  const req = { params: { id: '777' }, ip: '10.0.0.1' };
  for (let i = 1; i <= 3; i += 1) {
    const res = responseDouble();
    let passed = false;
    limiter(req, res, () => { passed = true; });
    assert.equal(passed, true, `attempt ${i} must pass`);
  }

  const blocked = responseDouble();
  let passed4 = false;
  limiter(req, blocked, () => { passed4 = true; });
  assert.equal(passed4, false, '4th attempt on the same job must be refused');
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.headers['Retry-After']);

  // Keyed on the JOB, not the operator: a different job is unaffected by the
  // budget the first one just spent.
  const other = responseDouble();
  let otherPassed = false;
  limiter({ params: { id: '778' }, ip: '10.0.0.1' }, other, () => { otherPassed = true; });
  assert.equal(otherPassed, true);
});
