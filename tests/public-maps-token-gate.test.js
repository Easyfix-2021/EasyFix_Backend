/*
 * routes/public/maps.js — the token+state gate on the three public map
 * endpoints, and the guarantee that the gate cannot take the process down.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * These are the only genuinely UNAUTHENTICATED routes that spend money. The
 * file's own header states the posture: no auth middleware applies, every
 * request must carry the magic-link JWT, and both `verifyJobToken()`
 * (time-bound) and `requireUnconfirmedJob()` (state-bound) run on EVERY
 * request — "Google spend is therefore gated by a verified Unconfirmed job".
 *
 * Two things follow, and this file asserts both rather than restating them:
 *
 *  1. THE GATE MUST PRECEDE THE SPEND. Every refusal path is checked for
 *     `upstream.calls === 0`. A response-only test cannot see this: a 401 is
 *     a 401 whether or not Places was called and billed first.
 *
 *  2. THE GATE MUST NOT BE ABLE TO EXIT THE PROCESS. On 2026-09-08 the
 *     `await verifyTokenAndState(req, res)` was moved INSIDE each handler's
 *     try. Express 4 attaches no .catch to an async handler's promise, so a
 *     rejection above the try reaches no error middleware, sends no response,
 *     and on Node 20 terminates the process. That is invisible in every
 *     response body, so the assertion is on whether the handler's promise
 *     SETTLES — see `settled` below, and `controlUnwrapped` at the end, which
 *     proves the harness can observe a rejection at all.
 *
 * Fully offline: db, utils/jwt and the network half of services/maps.service
 * are replaced in the require cache before the router is loaded. `getConfigKey`
 * is deliberately the REAL implementation, because one of the claims under
 * test is about which key it is allowed to hand a customer's browser.
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { errorHandler } = require('../middleware/error-handler');

/** Replace a module in the require cache before the subject requires it. */
function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/* The real key-selection logic, kept; only the billable calls are doubled. */
const realGetConfigKey = require('../services/maps.service').getConfigKey;

/* ─── switchboard: how the doubles behave for the current test ──────────── */
let tokenBehaviour;    // () => { jobId } | throws
let stateBehaviour;    // async (jobId) => void | throws
let upstream;          // call ledger for the Google-facing calls
let jobSeq = 0;        // a fresh rate-limit bucket per test

function resetDoubles() {
  jobSeq += 1;
  tokenBehaviour = () => ({ jobId: jobSeq });
  stateBehaviour = async () => {};
  upstream = { calls: 0, autocomplete: [], geocode: [], placeDetails: [], fail: null };
}
resetDoubles();

const spend = (bucket, arg) => {
  upstream.calls += 1;
  upstream[bucket].push(arg);
  if (upstream.fail) throw upstream.fail();
  return { ok: bucket };
};

stub('db', { pool: { query: async () => [[], []] } });
stub('utils/jwt', {
  verifyJobToken: (token) => tokenBehaviour(token),
  requireUnconfirmedJob: async (jobId) => stateBehaviour(jobId),
});
stub('services/maps.service', {
  autocomplete: async (q, sessionToken) => spend('autocomplete', { q, sessionToken }),
  geocode: async (args) => spend('geocode', args),
  placeDetails: async (args) => spend('placeDetails', args),
  getConfigKey: realGetConfigKey,
});

const router = require('../routes/public/maps');

/* ─── the driver ───────────────────────────────────────────────────────────
 * Runs the whole route stack (rate limit → validate → handler), then feeds
 * any next(err) through the repository's REAL errorHandler, so "a 500" is
 * measured against middleware/error-handler.js and not a stand-in. */
function stackFor(routePath) {
  const layer = router.stack.find((e) => e.route && e.route.path === routePath && e.route.methods.get);
  assert.ok(layer, `GET ${routePath} must be mounted`);
  return layer.route.stack;
}

const makeRes = () => ({
  statusCode: 200, body: null, locals: {},
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  setHeader() {},
});

let ipSeq = 0;
async function get(routePath, query) {
  const stack = stackFor(routePath);
  const res = makeRes();
  const req = {
    method: 'GET', originalUrl: `/api/public/maps${routePath}`, path: routePath,
    params: {}, query: { ...query }, body: {}, ip: `10.0.0.${++ipSeq % 250}`,
  };
  let nextErr = null;
  let rejected = null;
  try {
    for (const layer of stack) {
      let nexted = false;
      // `await` on the layer IS the probe. A rejection here is, in Express 4,
      // an unhandled rejection with nowhere to go.
      await layer.handle(req, res, (e) => { if (e) nextErr = e; nexted = true; });
      if (!nexted) break;
    }
  } catch (e) {
    rejected = e;
  }
  if (nextErr) errorHandler(nextErr, req, res, () => {});
  return { res, nextErr, rejected, settled: rejected === null };
}

const TOKEN = 'magic-link-jwt';
const ROUTES = [
  { path: '/autocomplete', query: { token: TOKEN, q: 'MG Road' } },
  { path: '/geocode', query: { token: TOKEN, address: 'MG Road' } },
  { path: '/config', query: { token: TOKEN } },
];

beforeEach(resetDoubles);

/* ─── structure: the token check is the ONLY gate ──────────────────────── */

test('there is no auth middleware on this router — the in-handler token check is the whole gate', () => {
  /*
   * The header's first security claim. If a `router.use()` gate ever appears
   * here the posture changed and the rest of this file's reasoning (a
   * customer's browser, holding no Bearer token, reaches these handlers)
   * needs revisiting. Asserted structurally rather than by reading the prose.
   */
  assert.equal(router.stack.filter((e) => !e.route).length, 0);
  assert.equal(router.stack.length, 3, 'autocomplete, geocode, config — and nothing else');
  for (const r of ROUTES) {
    assert.equal(stackFor(r.path).length, 3,
      `GET ${r.path} must be exactly [rate limit, validate, handler] — the token check lives INSIDE the handler`);
  }
});

/* ─── happy paths ──────────────────────────────────────────────────────── */

test('GET /autocomplete forwards the trimmed query and the session token', async () => {
  const { res, settled } = await get('/autocomplete', { token: TOKEN, q: '  MG Road  ', sessionToken: 'sess-1234' });
  assert.equal(settled, true);
  assert.deepEqual(res.body, { success: true, data: { ok: 'autocomplete' } });
  assert.equal(upstream.calls, 1);
  assert.deepEqual(upstream.autocomplete[0], { q: 'MG Road', sessionToken: 'sess-1234' });
});

test('GET /autocomplete without a sessionToken passes undefined, not an empty string', async () => {
  // An empty string would be sent to Places as a real session token and break
  // the session-billing grouping the header's 2026-07-24 note describes.
  await get('/autocomplete', { token: TOKEN, q: 'MG Road' });
  assert.equal(upstream.autocomplete[0].sessionToken, undefined);
});

test('GET /geocode with place_id AND sessionToken closes the session via placeDetails', async () => {
  // The header is explicit: BOTH present ⇒ placeDetails (session-billed),
  // never geocode (which ignores the session token and bills separately).
  const { res } = await get('/geocode', { token: TOKEN, place_id: 'ChIJ_place', sessionToken: 'sess-1234' });
  assert.deepEqual(res.body, { success: true, data: { ok: 'placeDetails' } });
  assert.equal(upstream.geocode.length, 0, 'the Geocoding API must not also be billed');
  assert.deepEqual(upstream.placeDetails[0], { place_id: 'ChIJ_place', sessionToken: 'sess-1234' });
});

test('GET /geocode with place_id and NO sessionToken uses geocode', async () => {
  const { res } = await get('/geocode', { token: TOKEN, place_id: 'ChIJ_place' });
  assert.deepEqual(res.body, { success: true, data: { ok: 'geocode' } });
  assert.equal(upstream.placeDetails.length, 0);
  assert.deepEqual(upstream.geocode[0], { place_id: 'ChIJ_place', address: null, latlng: null });
});

test('GET /geocode accepts address or latlng, and refuses a request with none of the three', async () => {
  const byLatLng = await get('/geocode', { token: TOKEN, latlng: '12.97,77.59' });
  assert.deepEqual(byLatLng.res.body, { success: true, data: { ok: 'geocode' } });
  assert.equal(upstream.geocode[0].latlng, '12.97,77.59');

  resetDoubles();
  const none = await get('/geocode', { token: TOKEN });
  assert.equal(none.res.statusCode, 400, '.or(place_id, address, latlng) must bite');
  assert.equal(upstream.calls, 0);
});

test('GET /config answers the modern envelope with the configured public key', async () => {
  const prev = process.env.GOOGLE_MAPS_API_KEY_PUBLIC;
  process.env.GOOGLE_MAPS_API_KEY_PUBLIC = 'PUBLIC-BROWSER-KEY';
  try {
    const { res, settled } = await get('/config', { token: TOKEN });
    assert.equal(settled, true);
    assert.deepEqual(res.body, { success: true, data: { apiKey: 'PUBLIC-BROWSER-KEY' } });
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_MAPS_API_KEY_PUBLIC;
    else process.env.GOOGLE_MAPS_API_KEY_PUBLIC = prev;
  }
});

test('⚠ GET /config never falls back to the server key, and degrades to null instead', async () => {
  /*
   * services/maps.service.js's getConfigKey header, changed 2026-05-28: the
   * server key is IP-restricted (or App-Restrictions=None + an API allowlist)
   * and is NOT referer-restricted to easyfix.in, so shipping it to a browser
   * would hand a customer's tab a higher-trust credential. Only
   * GOOGLE_MAPS_API_KEY_PUBLIC — which is referer-restricted on the GCP side —
   * may leave this endpoint; unset, the answer is null and the FE hides the
   * map. This route is unauthenticated, so it is the worst possible place for
   * that fallback to come back.
   */
  const prevPublic = process.env.GOOGLE_MAPS_API_KEY_PUBLIC;
  const prevServer = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY_PUBLIC;
  process.env.GOOGLE_MAPS_API_KEY = 'SERVER-ONLY-KEY-DO-NOT-SHIP';
  try {
    const { res } = await get('/config', { token: TOKEN });
    assert.deepEqual(res.body, { success: true, data: { apiKey: null } });
    assert.equal(JSON.stringify(res.body).includes('SERVER-ONLY-KEY-DO-NOT-SHIP'), false,
      'the server key must never reach a customer browser');
  } finally {
    if (prevPublic === undefined) delete process.env.GOOGLE_MAPS_API_KEY_PUBLIC;
    else process.env.GOOGLE_MAPS_API_KEY_PUBLIC = prevPublic;
    if (prevServer === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = prevServer;
  }
});

/* ─── refusals happen BEFORE the spend ─────────────────────────────────── */

const REFUSALS = [
  {
    label: 'no token at all',
    mutate: () => {},
    strip: true,
    expect: 400,                       // Joi: `token` is required — it never reaches the gate
  },
  {
    label: 'a forged / expired token',
    mutate: () => { tokenBehaviour = () => { throw { status: 401, message: 'invalid or expired link' }; }; },
    expect: 401,
  },
  {
    label: 'a valid token for a job that no longer exists',
    mutate: () => { stateBehaviour = async () => { throw { status: 404, code: 'JOB_NOT_FOUND', message: 'Order not found' }; }; },
    expect: 404,
  },
  {
    label: 'a still-valid token for an order ops has already confirmed',
    mutate: () => { stateBehaviour = async () => { throw { status: 410, code: 'JOB_NO_LONGER_PENDING', message: 'Order is no longer awaiting customer details' }; }; },
    expect: 410,
  },
];

for (const r of ROUTES) {
  for (const f of REFUSALS) {
    test(`GET ${r.path} · ${f.label} · refused with ${f.expect}, and Google is never called`, async () => {
      f.mutate();
      const query = { ...r.query };
      if (f.strip) delete query.token;
      const { res, settled } = await get(r.path, query);

      assert.equal(settled, true, 'the refusal must settle, not reject');
      assert.equal(res.statusCode, f.expect, JSON.stringify(res.body));
      assert.equal(res.body.success, false);
      assert.equal(upstream.calls, 0,
        'THE POINT OF THE GATE: a refused request must not have spent a Google call first');
    });
  }
}

test('the state check runs on EVERY request, not only the first', async () => {
  // The header: "Both layers run on every request, NOT just the page load."
  // A cached/one-shot state check would let a link keep working after ops
  // confirmed the order — the exact expiry this layer exists to enforce.
  let checks = 0;
  stateBehaviour = async () => { checks += 1; };
  await get('/autocomplete', { token: TOKEN, q: 'MG Road' });
  await get('/autocomplete', { token: TOKEN, q: 'MG Road' });
  await get('/config', { token: TOKEN });
  assert.equal(checks, 3, 'one live status check per request, across routes');
});

test('a link that goes inert mid-session stops spending immediately', async () => {
  const first = await get('/autocomplete', { token: TOKEN, q: 'MG Road' });
  assert.equal(first.res.body.success, true);
  assert.equal(upstream.calls, 1);
  // ops confirms the order — status leaves 9
  stateBehaviour = async () => { throw { status: 410, message: 'Order is no longer awaiting customer details' }; };
  const second = await get('/autocomplete', { token: TOKEN, q: 'MG Road again' });
  assert.equal(second.res.statusCode, 410);
  assert.equal(upstream.calls, 1, 'no further Google call was made after the link went inert');
});

/* ─── the gate must not be able to take the process down ───────────────── */

for (const r of ROUTES) {
  test(`GET ${r.path} · ⚠ a REJECTING guard settles as a 500 — it does not reject the handler`, async () => {
    /*
     * THE 2026-09-08 SHAPE, EXACTLY.
     *
     * verifyTokenAndState() swallows most faults in its own catch, so the one
     * way it rejects is for that catch to throw: it reads `e.status` and
     * `e.message` off whatever was thrown, and a non-object rejection (a
     * `throw null`, a library throwing a primitive) makes that read a
     * TypeError. That TypeError leaves the helper, and the handler's `try` is
     * the only thing standing between it and an unhandled rejection.
     *
     * With `await verifyTokenAndState(...)` back above the try this fails on
     * `settled`: the promise rejects, Express 4 observes nothing, no response
     * is sent, and Node 20 exits the process — for a request that should have
     * been one 500. The status code alone cannot see the difference, which is
     * why `settled` is asserted first.
     */
    tokenBehaviour = () => { throw null; };
    const { res, nextErr, settled, rejected } = await get(r.path, r.query);

    assert.equal(settled, true,
      'the handler promise REJECTED. In Express 4 that is an unhandled rejection and, on '
      + 'Node >= 15, a process exit — every in-flight request dies with it. The guard must '
      + `be awaited INSIDE the try. (${rejected && rejected.message})`);
    // An Error, not specifically a TypeError: since the 2026-09-08 gate fix the helper
    // no longer reads `.status` off a non-object at all — it normalises whatever was
    // thrown into a real Error before rethrowing. That normalisation is load-bearing:
    // a bare rethrow of `null` reaches Express as next(null), which it reads as "no
    // error, continue", and the request falls through with no 500, no log, no alert.
    assert.ok(nextErr instanceof Error, 'the fault must reach next() so errorHandler can answer');
    assert.notEqual(nextErr, null, 'next(null) would be read by Express as "no error, continue"');
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { success: false, error: 'Internal Server Error' },
      'and the internal message must not be echoed to an unauthenticated caller');
    assert.equal(upstream.calls, 0, 'a request that never passed the gate must not have spent anything');
  });
}

test('⚠ a DB fault during the state check settles and spends nothing', async () => {
  /*
   * `Queue limit reached.` is what mysql2 rejects with once the pool queue
   * fills — the fault a public, unauthenticated surface is most likely to
   * meet under load.
   *
   * REPORTED, NOT ASSERTED AS CORRECT: verifyTokenAndState maps ANY caught
   * error to `modernError(res, e.status || 401, e.message)`, so this driver
   * fault currently answers 401 with the raw driver text rather than a 500.
   * That is a finding on the route, not something this test blesses — so the
   * assertions here are limited to what is true either way: the promise
   * settles, a refusal is written, and no Google call is made.
   */
  stateBehaviour = async () => { throw new Error('Queue limit reached.'); };
  const { res, settled, rejected } = await get('/autocomplete', { token: TOKEN, q: 'MG Road' });
  assert.equal(settled, true, `handler promise rejected: ${rejected && rejected.message}`);
  assert.ok(res.statusCode >= 400, 'a DB fault must not be answered as success');
  assert.equal(res.body.success, false);
  assert.equal(upstream.calls, 0);
});

/* ─── upstream failures ────────────────────────────────────────────────── */

test('a Google failure carrying a status is passed through, not turned into a 500', async () => {
  // maps.service throws { status: 503 } when GOOGLE_MAPS_API_KEY is unset —
  // the operator-actionable case, so the status must survive to the client.
  upstream.fail = () => ({ status: 503, message: 'Google Maps not configured (GOOGLE_MAPS_API_KEY missing)' });
  const { res, settled } = await get('/autocomplete', { token: TOKEN, q: 'MG Road' });
  assert.equal(settled, true);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /GOOGLE_MAPS_API_KEY missing/);
});

test('an unexpected Google failure settles as a 500 with no internal detail', async () => {
  upstream.fail = () => new Error('fetch failed: ECONNRESET');
  const { res, nextErr, settled } = await get('/geocode', { token: TOKEN, address: 'MG Road' });
  assert.equal(settled, true);
  assert.ok(nextErr instanceof Error);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, error: 'Internal Server Error' });
});

/* ─── differential control ─────────────────────────────────────────────── */

test('controlUnwrapped: the harness can still observe a rejection', async () => {
  // Without this, a driver incapable of surfacing a rejection would report
  // every `settled` assertion above as green against the broken version.
  let rejected = null;
  try {
    await (async () => { throw new Error('Queue limit reached.'); })();
  } catch (e) { rejected = e; }
  assert.ok(rejected instanceof Error, 'the driver must be able to see a rejected handler promise');

  // …and the same shape driven through the real stack loop, so the control
  // covers the loop, not just a bare await.
  const res = makeRes();
  let loopRejected = null;
  try {
    for (const layer of [{ handle: async () => { throw new Error('boom'); } }]) {
      await layer.handle({ query: {} }, res, () => {});
    }
  } catch (e) { loopRejected = e; }
  assert.match(loopRejected.message, /boom/);
});

after(() => { /* nothing opened: db is stubbed, no pool, no sockets */ });

/* ─── the 2026-09-08 gate fix: infrastructure faults are 500s, not 401s ──── */

for (const r of ROUTES) {
  test(`GET ${r.path} · a POOL FAULT is a 500, never a 401 carrying the driver's message`, async () => {
    /*
     * The defect this pins: verifyTokenAndState's catch used to be
     * `modernError(res, e.status || 401, e.message || 'unauthorized')`. Every
     * DELIBERATE rejection here carries an explicit status (401 bad token, 404
     * no such job, 410 order no longer pending), so `|| 401` only ever caught
     * the ones that DON'T — pool faults, dead sockets, TypeErrors.
     *
     * Three consequences, and the third is why it survived:
     *   1. the customer is told their link is invalid when it is perfectly fine
     *   2. internal text ("Queue limit reached.") is handed to an
     *      unauthenticated caller on a PUBLIC endpoint
     *   3. a database outage produced no 5xx at all, so nothing watching error
     *      rates could see it — the failure was invisible by construction
     *
     * Asserting the STATUS is the whole point. Every weaker assertion (it
     * settles, it refuses, it bills nothing) held just as well before the fix.
     */
    stateBehaviour = async () => { throw new Error('Queue limit reached.'); };
    const { res, nextErr, settled, rejected } = await get(r.path, r.query);

    assert.equal(settled, true, `handler promise rejected (${rejected && rejected.message})`);
    assert.notEqual(nextErr, null,
      'next() was never called with an error — Express reads next(null) as "no error, continue", '
      + 'so the request falls through with no 500, no log and no alert');
    assert.equal(res.statusCode, 500,
      'a pool fault must be a 500. A 401 tells the customer their link is broken, and hides a '
      + 'database outage from every error-rate alert');
    assert.notEqual(res.statusCode, 401, 'specifically NOT the pre-fix 401');
    assert.deepEqual(res.body, { success: false, error: 'Internal Server Error' },
      'and the driver message must not be echoed to an unauthenticated caller');
    assert.doesNotMatch(JSON.stringify(res.body), /Queue limit/,
      'internal error text must not reach a public caller');
    assert.equal(upstream.calls, 0, 'nothing billed for a request that never passed the gate');
  });
}

test('control: a DELIBERATE rejection still answers with its own status, unchanged', async () => {
  // Without this, the tests above would also pass against a gate that answered
  // 500 for everything — including expired links, which must stay 401 so the
  // FE can render "this link is no longer active" rather than an error page.
  stateBehaviour = async () => { throw { status: 410, code: 'JOB_NO_LONGER_PENDING', message: 'Order is no longer awaiting customer details' }; };
  const { res, nextErr } = await get('/geocode', { token: TOKEN, address: 'MG Road' });
  assert.equal(res.statusCode, 410, 'a real state rejection keeps its status');
  assert.equal(nextErr, null, 'and is answered in place, not escalated to errorHandler');
  assert.match(JSON.stringify(res.body), /no longer awaiting/);
});
