'use strict';
/*
 * ONE offerability predicate — job.jobOfferability — read by both the offer
 * guard and GET /admin/jobs/:id/candidates.
 *
 * ─── WHY THIS EXISTS (2026-09-10) ──────────────────────────────────────────
 *
 * The rule was answered in two places that did not agree. offerToTechnicians
 * refused on `job_status !== BOOKED || fk_easyfixter_id != null`; the CRM's
 * Schedule & Assign modal gated its commit button on `job_status !== 0` ALONE.
 * A gate reading a SUBSET of a guard's inputs is not a weaker gate, it is a
 * different one, and the difference is exactly the set of states where the UI
 * promises an action the server refuses. Production job 534947 sat in that set
 * (BOOKED, still owned by a legacy direct assignment) and absorbed 16
 * consecutive 409s from two operators before they gave up.
 *
 * ─── WHAT IS ASSERTED, AND WHY THESE ───────────────────────────────────────
 *
 * The refactor's whole risk is that the extracted predicate does not mean what
 * the guard used to mean. So the load-bearing test is an EQUIVALENCE MATRIX
 * over every declared status crossed with owner/no-owner, comparing
 * `!claimableNow` against the literal condition the guard carried before —
 * and it enumerates the statuses from job.ALL_STATUS_VALUES rather than a
 * hand-written list, so a status added later cannot slip past untested.
 *
 * The matrix is itself positive-controlled: it asserts both outcomes actually
 * occur. A matrix that silently produced one verdict everywhere would agree
 * with any predicate at all, including a constant.
 *
 * Then two DELEGATION pins, mirroring tests/job-offers-expiry-regime.test.js:
 * the guard and the route must CALL the helper rather than restate the rule,
 * because a restatement is exactly how the two answers drifted apart the first
 * time. The route pin is a runtime call, not a regex, so it also proves the
 * fields reach the response body.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const job = require(path.join(ROOT, 'services/job.service'));

const BOOKED = 0;

/* ─── the predicate itself ─────────────────────────────────────────────── */

test('EQUIVALENCE: !claimableNow is byte-for-byte the guard condition it replaced', () => {
  /*
   * The old guard, verbatim from before the refactor:
   *     Number(lockedJob.job_status) !== STATUS.BOOKED || lockedJob.fk_easyfixter_id != null
   * If the extracted predicate disagrees on ANY cell, the refactor changed
   * which requests are refused — silently, because both versions still 409.
   */
  const statuses = [...job.ALL_STATUS_VALUES];
  assert.ok(statuses.length >= 8,
    `expected the declared status set, got ${statuses.length} — if this is 0 the export moved `
    + 'and the matrix below would run over nothing while still reporting a pass');

  const owners = [null, undefined, 99];
  let refused = 0;
  let allowed = 0;
  for (const job_status of statuses) {
    for (const fk_easyfixter_id of owners) {
      const row = { job_id: 1, job_status, fk_easyfixter_id };
      const wouldRefuse = Number(job_status) !== BOOKED || fk_easyfixter_id != null;
      const doesRefuse = !job.jobOfferability(row).claimableNow;
      assert.equal(doesRefuse, wouldRefuse,
        `status ${job_status} / owner ${String(fk_easyfixter_id)}: guard used to `
        + `${wouldRefuse ? 'REFUSE' : 'ALLOW'}, predicate now `
        + `${doesRefuse ? 'REFUSES' : 'ALLOWS'}`);
      if (doesRefuse) refused += 1; else allowed += 1;
    }
  }
  // Positive control on the matrix: a run that produced one verdict everywhere
  // would agree with a constant function and prove nothing.
  assert.ok(refused > 0 && allowed > 0,
    `the matrix must exercise both outcomes; got ${refused} refused / ${allowed} allowed `
    + `across ${statuses.length} statuses x ${owners.length} owner values`);
});

test('BOOKED and ownerless → offerable, claimable, nothing to release', () => {
  const o = job.jobOfferability({ job_status: 0, fk_easyfixter_id: null });
  assert.deepEqual(o, { offerable: true, reason: null, releasesOwner: false, claimableNow: true });
});

test('BOOKED but OWNED → offerable, NOT claimable, releases the owner first', () => {
  /*
   * The reported state. `offerable: true` is what unblocks the CRM button;
   * `claimableNow: false` is what keeps the locked guard refusing a write until
   * the release has actually happened. Both must hold at once — collapsing them
   * into one boolean is how this ends up either dead-ended again (if the UI
   * reads claimableNow) or double-booking (if the guard reads offerable).
   */
  const o = job.jobOfferability({ job_status: 0, fk_easyfixter_id: 8455 });
  assert.deepEqual(o, { offerable: true, reason: null, releasesOwner: true, claimableNow: false });
});

test('every NON-booked status is refused with the same machine-readable reason', () => {
  // The CRM renders copy off `reason`, so an unlabelled refusal would surface
  // as a blank banner rather than an explanation.
  const others = [...job.ALL_STATUS_VALUES].filter((s) => Number(s) !== BOOKED);
  assert.ok(others.length > 0, 'the status set must contain something other than BOOKED');
  for (const s of others) {
    // BOTH owner shapes. Only the OWNED row can prove releasesOwner does not
    // leak into the not-booked branch — with fk NULL the assertion below is
    // vacuous, and a leak there would silently pool a SCHEDULED or COMPLETED
    // job by releasing a technician who is legitimately on it.
    for (const fk_easyfixter_id of [null, 8455]) {
      const o = job.jobOfferability({ job_status: s, fk_easyfixter_id });
      assert.equal(o.offerable, false, `status ${s} must not be offerable`);
      assert.equal(o.reason, 'not_booked');
      assert.equal(o.claimableNow, false, `status ${s} must never be claimable`);
      assert.equal(o.releasesOwner, false,
        `status ${s} with owner ${String(fk_easyfixter_id)} must never trigger a release`);
    }
  }
});

test('a missing or shapeless row fails CLOSED', () => {
  // The route hands it req.scopedJob; a 404-shaped miss must not read as
  // offerable, which Number(undefined) === NaN quietly delivers.
  for (const bad of [null, undefined, {}, { job_status: null }, { job_status: 'BOOKED' }]) {
    const o = job.jobOfferability(bad);
    assert.equal(o.offerable, false, `${JSON.stringify(bad)} must fail closed`);
    assert.equal(o.claimableNow, false);
  }
});

/* ─── delegation: the two readers must not restate the rule ────────────── */

test('the offer GUARD calls the helper and no longer carries its own condition', () => {
  /*
   * Mirrors tests/job-offers-expiry-regime.test.js' "the field tracks the
   * service, not a literal". A guard that recomputed the rule could drift from
   * the route's answer, which IS the defect being removed — so the drift has to
   * be structurally impossible, not merely currently absent.
   */
  const src = fs.readFileSync(path.join(ROOT, 'services/job.service.js'), 'utf8');
  const guard = src.match(/if \(!jobOfferability\(lockedJob\)\.claimableNow\) \{\s*\n\s*const err = new Error\('job must be BOOKED and unassigned/);
  assert.ok(guard, 'the JOB_NOT_OFFERABLE guard must be computed from jobOfferability(...).claimableNow');
  assert.ok(
    !/Number\(lockedJob\.job_status\) !== STATUS\.BOOKED \|\| lockedJob\.fk_easyfixter_id != null/.test(src),
    'the old inline condition must be GONE, not merely shadowed — two copies is the bug',
  );
  // And the release branch reads the same helper rather than re-testing the pair.
  assert.match(src, /if \(jobOfferability\(existing\)\.releasesOwner\) \{/,
    'the stale-owner release must key on releasesOwner');
});

test('RUNTIME: GET /:id/candidates answers with the helper, for both verdicts', async () => {
  /*
   * A regex would prove the route mentions the helper; driving it proves the
   * fields reach the body — the half the CRM actually reads. Both verdicts are
   * exercised: hardcoding `offerable: true` would satisfy a one-sided test and
   * put the dead-end button straight back.
   */
  const router = require(path.join(ROOT, 'routes/admin/jobs'));
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/:id/candidates' && l.route.methods.get,
  );
  assert.ok(layer, 'GET /:id/candidates must be mounted on the admin jobs router');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  const ranking = require(path.join(ROOT, 'services/candidate-ranking.service'));
  const realRank = ranking.rankCandidatesForJob;
  const realExpire = job.expireStaleOffers;
  const realActive = job.isOfferFlowActive;
  ranking.rankCandidatesForJob = async () => ({ job: { job_id: 7 }, candidates: [], alreadyAssigned: false });
  job.expireStaleOffers = async () => 0;
  job.isOfferFlowActive = async () => true;
  try {
    const call = async (scopedJob) => {
      const res = { statusCode: 200, body: null };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (b) => { res.body = b; return res; };
      await handler(
        { params: { id: '7' }, query: { limit: 10 }, scopedJob },
        res,
        (e) => { throw e || new Error('next()'); },
      );
      return res.body.data;
    };

    const booked = await call({ job_id: 7, job_status: 0, fk_easyfixter_id: null });
    assert.equal(booked.offerable, true);
    assert.equal(booked.offerBlockReason, null);
    assert.equal(booked.offerFlowEnabled, true, 'the existing field must still be sent');
    assert.deepEqual(booked.candidates, [], 'and the list must pass through untouched');

    const owned = await call({ job_id: 7, job_status: 0, fk_easyfixter_id: 8455 });
    assert.equal(owned.offerable, true,
      'a BOOKED job with a stale owner IS offerable — the server releases first');

    const completed = await call({ job_id: 7, job_status: 3, fk_easyfixter_id: 8455 });
    assert.equal(completed.offerable, false, 'the negative verdict must reach the body too');
    assert.equal(completed.offerBlockReason, 'not_booked');
  } finally {
    ranking.rankCandidatesForJob = realRank;
    job.expireStaleOffers = realExpire;
    job.isOfferFlowActive = realActive;
  }
});
