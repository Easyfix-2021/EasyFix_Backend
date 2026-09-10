'use strict';
/*
 * GET /admin/jobs/:id/offers reports WHICH EXPIRY REGIME is in force.
 *
 * ─── THE MISLEADING CAPTION THIS EXISTS FOR (2026-09-10) ───────────────────
 *
 * Schedule & Assign told operators, unconditionally:
 *
 *     "open offers expire after 30 minutes"
 *
 * Production runs `job.offer_expiry.enabled = 'false'`, so nothing times an
 * offer out at all. Worse, the two things an operator infers from an EXPIRED
 * chip — "there was a 30-minute window" and "the technician let it lapse" —
 * were both wrong. `offer_status = 3 EXPIRED` is written by NINE code paths and
 * only ONE of them (expireStaleOffers) honours the flag; the rest close an
 * offer because the job was assigned, rescheduled, released, withdrawn, or
 * superseded by a sibling accepting.
 *
 * Reported on job 538177: two offers read EXPIRED after ~22 hours with the
 * sweep switched off. Their `responded_at` was identical to the second, six
 * seconds before a re-offer went out — one statement in one transaction, not a
 * timeout. Reading that as "the technician ignored it" is a claim about a
 * person, and candidate-ranking scores acceptance from these same rows.
 *
 * The frontend cannot know the regime on its own, so the route now says. This
 * pins that it does, under BOTH settings — a field that silently stopped being
 * sent would return the caption to asserting a rule that is not in force,
 * which is the failure being fixed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Locate the express layer for GET /:id/offers on the admin jobs router. */
function offersLayer() {
  const router = require(path.join(ROOT, 'routes/admin/jobs'));
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/:id/offers' && l.route.methods.get,
  );
  assert.ok(layer, 'GET /:id/offers must be mounted on the admin jobs router');
  return layer;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

/**
 * Drive the route's own final handler with job.listOffers and
 * job.offerExpiryEnabled stubbed. The handler is the LAST function on the
 * layer's stack — the ones before it are validate() and scopedJob, which need
 * a database.
 */
async function callRoute({ expiry, items = [] }) {
  const jobSvc = require(path.join(ROOT, 'services/job.service'));
  const realList = jobSvc.listOffers;
  const realFlag = jobSvc.offerExpiryEnabled;
  jobSvc.listOffers = async () => items;
  jobSvc.offerExpiryEnabled = () => expiry;
  try {
    const handler = offersLayer().route.stack[offersLayer().route.stack.length - 1].handle;
    const res = fakeRes();
    await handler({ params: { id: '538177' }, query: {} }, res, (e) => { throw e || new Error('next()'); });
    return res;
  } finally {
    jobSvc.listOffers = realList;
    jobSvc.offerExpiryEnabled = realFlag;
  }
}

test('the response reports offer_expiry_enabled = false when the business switch is off', async () => {
  const res = await callRoute({ expiry: false });
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.offer_expiry_enabled, false,
    'production runs with expiry OFF; without this field the modal goes back to promising '
    + 'a 30-minute window that nothing enforces');
});

test('and = true when it is on', async () => {
  // The positive control. Without it, hardcoding `false` would pass the test
  // above — and the caption would then be wrong in the OTHER direction for any
  // environment that enables the sweep.
  const res = await callRoute({ expiry: true });
  assert.equal(res.body.data.offer_expiry_enabled, true);
});

test('the field tracks the service, not a literal', async () => {
  /*
   * Asserts the route DELEGATES rather than restating the rule. A route that
   * computed the regime itself could drift from expireStaleOffers' own gate,
   * which is the divergence job.service.js's single-helper comment exists to
   * prevent.
   */
  const src = require('fs').readFileSync(path.join(ROOT, 'routes/admin/jobs.js'), 'utf8');
  const block = src.match(/modernOk\(res, \{ items, offer_expiry_enabled:[^)]*\)/);
  assert.ok(block, 'the offers route must send offer_expiry_enabled alongside items');
  assert.match(block[0], /job\.offerExpiryEnabled\(\)/,
    'it must call the one exported helper — the same one expireStaleOffers gates on');
});

test('items are still returned unchanged alongside it', async () => {
  // The shape is additive: an older frontend reading only `items` must not
  // break, which is the whole reason the field is optional client-side.
  const items = [{ efr_id: 8455, efr_name: 'M Srikanth', offer_status: 0 }];
  const res = await callRoute({ expiry: false, items });
  assert.deepEqual(res.body.data.items, items);
});
