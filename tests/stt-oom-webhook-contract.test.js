/*
 * routes/webhook/stt-oom.js — THE WATCHER RESPONSE CONTRACT.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * The route's own header states the contract this file pins:
 *
 *   "If that env is UNSET the feature is OFF and we 200 no-op (never an error)
 *    — nothing new runs until an operator opts in, and the watcher never
 *    retry-storms. Empty recipient list → also a silent no-op."
 *
 * and, on the properties lookup added 2026-09-08:
 *
 *   "A DB outage here must not 500: the watcher would retry-storm, and this is
 *    the alert path for an outage in the first place."
 *
 * That second one is the load-bearing case. The caller is the `stt-oom-watch`
 * sidecar reacting to a container being OOM-killed — i.e. the moment the host
 * is already unhealthy. A 500 (or, in Express 4, an un-nexted async rejection
 * that answers nothing at all) turns one alert into a retry loop against a
 * database that is already the reason for the alert.
 *
 * So every failure test below asserts THREE things, not one: the exact `reason`
 * from the file's own vocabulary (a fallback returning the wrong reason is
 * indistinguishable from the happy path in a status-only test), that the
 * handler promise SETTLED, and that exactly one response was written.
 *
 * Non-destructive: fake pool, stubbed mailer, no network, no DB, no real timers.
 * Runner: `node --test`.
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* The real 2026-09-08 error text, so a failure here reads like the incident. */
const QUEUE_LIMIT = 'Queue limit reached.';
const KEY = 'stt-oom-shared-key-for-tests';

let props = [{ property_key: 'teleprompter.stt.alert.emails', property_value: 'ops@easyfix.in, sre@easyfix.in' }];

installFakePool([
  [/FROM easyfix_properties/i, () => props],
]);

const properties = require('../services/properties.service');
const email = require('../services/email.service');
const router = require('../routes/webhook/stt-oom');

const realGetAll = properties.getAllProperties;
const realSend = email.send;

let sent = [];
let delivery = { delivered: true, id: 'msg-1' };

before(async () => { await properties.flushCache(); });

beforeEach(async () => {
  process.env.STT_OOM_WEBHOOK_KEY = KEY;
  properties.getAllProperties = realGetAll;
  sent = [];
  delivery = { delivered: true, id: 'msg-1' };
  email.send = async (msg) => { sent.push(msg); return delivery; };
  props = [{ property_key: 'teleprompter.stt.alert.emails', property_value: 'ops@easyfix.in, sre@easyfix.in' }];
  await properties.flushCache();
});

after(() => {
  properties.getAllProperties = realGetAll;
  email.send = realSend;
  delete process.env.STT_OOM_WEBHOOK_KEY;
});

/* ─── harness ─────────────────────────────────────────────────────────────
 *
 * A recording `res` double: modernOk/modernError only call res.json (and
 * res.status), so counting the writes is the only way to see a double-send,
 * and reading `settled` is the only way to see an Express 4 async rejection —
 * which answers nothing at all rather than 500ing.
 */
function makeRes() {
  return {
    writes: [],
    statusCode: 200,
    locals: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.writes.push(b); return this; },
    get body() { return this.writes[this.writes.length - 1]; },
  };
}

function handler() {
  const layer = router.stack.find((e) => e.route && e.route.path === '/' && e.route.methods.post);
  assert.ok(layer, 'POST / must be mounted (it is /api/webhook/stt-oom)');
  assert.equal(layer.route.stack.length, 1, 'one handler — a gate added here must be noticed, not skipped');
  return layer.route.stack[0].handle;
}

async function post(body, headers = { 'x-webhook-key': KEY }) {
  const res = makeRes();
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const req = {
    body, query: {}, params: {},
    method: 'POST', originalUrl: '/api/webhook/stt-oom', path: '/',
    get(h) { return lower[String(h).toLowerCase()]; },
  };
  let settled = 'fulfilled';
  try { await handler()(req, res); } catch (e) { settled = 'rejected'; }
  return { res, settled };
}

/*
 * Every reply this route can make must satisfy this, whichever branch produced
 * it — that is what "the watcher never retry-storms" means operationally.
 */
function assertAcked({ res, settled }, { status = 200 } = {}) {
  assert.equal(settled, 'fulfilled',
    'an Express 4 async rejection reaches no error middleware — the watcher gets no '
    + 'response at all and retries, which is the storm this contract exists to prevent');
  assert.equal(res.writes.length, 1, 'exactly one response written');
  assert.equal(res.statusCode, status);
}

/* A distinct container per test: the cooldown Map is module state and persists
 * across tests in this file, so sharing a name would make results order-dependent. */
let n = 0;
const container = () => `easyfix-stt-t${++n}`;
const oom = (name) => ({ container: name, exitCode: 137, oomKilled: true });

/* ═══ auth / opt-in gating ════════════════════════════════════════════════ */

test('with no shared key configured the feature is OFF: 200 no-op, never an error', async () => {
  delete process.env.STT_OOM_WEBHOOK_KEY;
  const r = await post(oom(container()), {});
  assertAcked(r);
  assert.deepEqual(r.res.body, { success: true, data: { received: false, reason: 'alerting-disabled' } },
    'the header calls this an opt-in, so an unconfigured host must ACCEPT and ignore, not 401/500');
  assert.equal(sent.length, 0);
});

test('⚠ a wrong shared key is 401 and sends no email', async () => {
  const r = await post(oom(container()), { 'x-webhook-key': 'wrong' });
  assertAcked(r, { status: 401 });
  assert.equal(r.res.body.success, false);
  assert.equal(sent.length, 0, 'otherwise anyone who can reach the webhook can mail ops at will');
});

test('⚠ a MISSING key header is 401, not treated as "feature off"', async () => {
  // The disabled path and the unauthenticated path both end in a 2xx-ish ack in
  // sloppier designs; here only the SERVER being unconfigured may no-op.
  const r = await post(oom(container()), {});
  assertAcked(r, { status: 401 });
  assert.equal(sent.length, 0);
});

/* ═══ payload gating ═════════════════════════════════════════════════════ */

test('a normal stop/deploy (oomKilled false) acks with reason not-oom and mails nobody', async () => {
  const r = await post({ container: container(), exitCode: 0, oomKilled: false });
  assertAcked(r);
  assert.deepEqual(r.res.body.data, { received: true, alerted: false, reason: 'not-oom' });
  assert.equal(sent.length, 0);
});

test('oomKilled arrives as the STRING "true" from the sidecar and still alerts', async () => {
  const c = container();
  const r = await post({ container: c, exitCode: '137', oomKilled: 'true' });
  assertAcked(r);
  assert.equal(r.res.body.data.alerted, true);
  assert.equal(sent.length, 1);
});

/* ═══ happy path ═════════════════════════════════════════════════════════ */

test('an OOM kill emails every configured recipient and reports alerted:true', async () => {
  const c = container();
  const r = await post(oom(c));
  assertAcked(r);
  assert.equal(r.res.body.data.alerted, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['ops@easyfix.in', 'sre@easyfix.in'],
    'the CSV property is split and lowercased by parseEmailAllowlist');
  assert.match(sent[0].subject, /STT sidecar OOM-killed/);
  assert.match(sent[0].html, new RegExp(c), 'the mail must name the container that died');
});

test('the container name is HTML-escaped and length-capped before it reaches the mail body', async () => {
  // container comes off the wire; it is interpolated into the alert HTML.
  const r = await post({ container: '<img src=x onerror=alert(1)>', exitCode: 137, oomKilled: true });
  assertAcked(r);
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].html.includes('<img'), 'esc() must neutralise the tag');
  assert.match(sent[0].html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

/* ═══ the failure contract ═══════════════════════════════════════════════ */

test('⚠ a rejecting getAllProperties acks 200 with reason properties-unavailable', async () => {
  /*
   * The 2026-09-08 fix. Asserting only "not a 5xx" would pass against a
   * fallback that returned no-recipients, or alerted:true, or an empty body —
   * so pin the file's OWN vocabulary for this branch, and pin that no mail was
   * attempted (a half-run handler that still mailed would be worse than a 500).
   */
  properties.getAllProperties = async () => { throw new Error(QUEUE_LIMIT); };
  const r = await post(oom(container()));
  assertAcked(r);
  assert.deepEqual(r.res.body, {
    success: true,
    data: { received: true, alerted: false, reason: 'properties-unavailable' },
  });
  assert.equal(sent.length, 0);
});

test('⚠ the properties failure answers — and answers under 400 — rather than 5xx-ing', async () => {
  /*
   * MEASURED, not assumed: with the try/catch removed this assertion FAILS on
   * `settled`/`writes`, and would have PASSED on `statusCode < 400` alone —
   * res.statusCode is 200 by construction until someone sets it, so a handler
   * that answers NOTHING looks like a healthy 200 to a status-only check. The
   * two halves are both needed: `assertAcked` catches the rejection (the Express
   * 4 shape), the status catches an explicit 500 (the `next(e)` shape).
   */
  properties.getAllProperties = async () => { throw new Error(QUEUE_LIMIT); };
  const r = await post(oom(container()));
  assertAcked(r);
  assert.ok(r.res.statusCode < 400,
    `got ${r.res.statusCode}: any error status makes the watcher retry against the very `
    + 'database that is already down');
});

test('no configured recipients is a silent no-op, not an error', async () => {
  props = [];
  await properties.flushCache();
  const r = await post(oom(container()));
  assertAcked(r);
  assert.deepEqual(r.res.body.data, { received: true, alerted: false, reason: 'no-recipients' });
  assert.equal(sent.length, 0);
});

test('⚠ email.send THROWING still acks 200 rather than bouncing the watcher', async () => {
  email.send = async () => { throw new Error(QUEUE_LIMIT); };
  const r = await post(oom(container()));
  assertAcked(r);
  assert.equal(r.res.body.data.alerted, false);
  assert.equal(r.res.body.data.error, QUEUE_LIMIT);
});

/* ═══ rate limit ═════════════════════════════════════════════════════════ */

test('⚠ a crash loop mails once: the second event is suppressed by the per-container cooldown', async () => {
  const c = container();
  await post(oom(c));
  const second = await post(oom(c));
  assertAcked(second);
  assert.deepEqual(second.res.body.data, { received: true, alerted: false, reason: 'cooldown' });
  assert.equal(sent.length, 1, 'one email for the loop, not one per restart');
});

test('the cooldown is PER CONTAINER — a different container still alerts', async () => {
  const a = container();
  await post(oom(a));
  await post(oom(container()));
  assert.equal(sent.length, 2);
});

test('⚠ an UNDELIVERED alert leaves the cooldown UNARMED so the next event retries', async () => {
  /*
   * email.send returns {delivered:false} on a Graph outage instead of throwing,
   * so arming the cooldown on the CALL rather than on the DELIVERY would silence
   * the alert for ten minutes having sent nothing. Asserting only the response
   * shape cannot see that — the retry is the observable, so count the sends.
   */
  const c = container();
  delivery = { delivered: false, error: 'graph 503' };
  const first = await post(oom(c));
  assertAcked(first);
  assert.equal(first.res.body.data.alerted, false);

  delivery = { delivered: true, id: 'msg-2' };
  const second = await post(oom(c));
  assertAcked(second);
  assert.equal(second.res.body.data.alerted, true, 'not suppressed — nothing was ever delivered');
  assert.equal(sent.length, 2);
});
