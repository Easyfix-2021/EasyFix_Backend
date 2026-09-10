/*
 * Onboarding training completes on MANDATORY CONTENT, not on mandatory videos.
 *
 * ─── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * A mandatory course holds lms_content of kind video, document or assessment.
 * `mandatoryVideoIdsSql()` selects `lc.kind = 'video'`, so a course whose only
 * item is an assessment contributed NOTHING to the gate: the technician was
 * reported training-complete without passing it, and job access unlocked.
 *
 * Meanwhile `isTrainingComplete()` — the LIFECYCLE predicate — judges all three
 * kinds through `itemCompleteSql`. Two predicates, one question, opposite
 * answers about the same person. Production carries exactly that shape:
 * "Electrician Assessment" is is_mandatory=1 / status=1 and holds one item, an
 * assessment, with no videos at all.
 *
 * ─── WHAT IS PINNED ────────────────────────────────────────────────────────
 *
 * The video half must keep behaving EXACTLY as it did — it survived a
 * platform-wide outage on 2026-08-26 (a course video raised `total` for every
 * technician and unlocked-jobs went false for ~2,600 people), and the fix for
 * that is the "both halves must use the same set" rule the service states. The
 * set is WIDENED here, never replaced, so the video-only deployment returns its
 * original value verbatim.
 *
 * NOT COVERED HERE, deliberately: the pre-migration path where `courses` has no
 * `is_mandatory` column. `lmsFlagColumns()` caches its probe at module scope
 * with a TTL, so a test that answered the probe differently would poison every
 * later case in this file and make the suite order-dependent. That guard mirrors
 * the existing `videoGlobal` degrade in the same function.
 *
 *   node --test --test-force-exit tests/training-gate-non-video.test.js
 */
'use strict';

process.env.NOTIFICATIONS_DISABLE = 'true';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* Both flag columns present — the post-migration schema every live deployment
 * has. Answered from the probe so the service takes its normal path. */
const FLAG_ROWS = [
  { t: 'courses', c: 'is_mandatory' },
  { t: 'training_videos', c: 'is_global' },
];

/** The two halves, reset per test. */
let videos = { total: 0, done: 0, last_done: null };
let nonVideo = { total: 0, done: 0, last_done: null };

/*
 * ORDER MATTERS, and the obvious ordering is wrong. The non-video statement
 * embeds `itemCompleteSql`, which contains `FROM easyfixer_watched_video` in
 * its video arm — so a route matching that pattern captures BOTH queries and
 * hands the video rows to both halves. The first version of this file did
 * exactly that: `total` doubled, and the one case that could detect it
 * (mandatory assessment, no mandatory videos) collapsed into the empty-set
 * branch and read as a bug in the service.
 *
 * The narrower pattern therefore goes first: only the non-video statement
 * selects FROM easyfixer_courses.
 */
const fake = installFakePool([
  [/information_schema\.columns/i, () => FLAG_ROWS],
  [/FROM easyfixer_courses ec/i, () => [nonVideo]],
  [/FROM easyfixer_watched_video/i, () => [videos]],
]);

const { fetchTrainingCompletedTime } = require('../services/mobile-registration.service');

const VIDEO_STAMP = '2026-09-01 10:00:00';
const ASSESS_STAMP = '2026-09-05 16:30:00';

beforeEach(() => {
  fake.calls.length = 0;
  videos = { total: 0, done: 0, last_done: null };
  nonVideo = { total: 0, done: 0, last_done: null };
});

test('THE BUG: every mandatory video watched, mandatory assessment unpassed → NOT complete', async () => {
  videos = { total: 3, done: 3, last_done: VIDEO_STAMP };
  nonVideo = { total: 1, done: 0, last_done: null };

  assert.equal(
    await fetchTrainingCompletedTime(42), null,
    'a technician who has not passed the mandatory assessment is not trained.\n'
    + '  Before this, the assessment was invisible to the gate and the three\n'
    + '  videos alone unlocked job access.',
  );
});

test('both halves finished → complete, stamped with the LATER of the two', async () => {
  videos = { total: 3, done: 3, last_done: VIDEO_STAMP };
  nonVideo = { total: 1, done: 1, last_done: ASSESS_STAMP };

  assert.equal(
    await fetchTrainingCompletedTime(42), ASSESS_STAMP,
    'training finishes when the LAST item does, not when the last video does',
  );
});

test('the assessment finishing FIRST does not backdate to it', async () => {
  videos = { total: 3, done: 3, last_done: VIDEO_STAMP };
  nonVideo = { total: 1, done: 1, last_done: '2026-08-01 09:00:00' };

  assert.equal(await fetchTrainingCompletedTime(42), VIDEO_STAMP);
});

test('a video-only deployment is untouched, and gets its value VERBATIM', async () => {
  videos = { total: 3, done: 3, last_done: VIDEO_STAMP };
  nonVideo = { total: 0, done: 0, last_done: null };

  const result = await fetchTrainingCompletedTime(42);
  assert.equal(result, VIDEO_STAMP);
  assert.equal(
    typeof result, 'string',
    'the common path must return the stored value as-is, not one round-tripped\n'
    + '  through a Date — the payload shape is observable to the app',
  );
});

test('an unfinished video still blocks, even with every non-video item done', async () => {
  videos = { total: 3, done: 2, last_done: VIDEO_STAMP };
  nonVideo = { total: 1, done: 1, last_done: ASSESS_STAMP };

  assert.equal(await fetchTrainingCompletedTime(42), null,
    'widening the set must not weaken the half that was already enforced');
});

test('NOTHING mandatory at all → not complete, and it says so loudly', async () => {
  videos = { total: 0, done: 0, last_done: null };
  nonVideo = { total: 0, done: 0, last_done: null };

  assert.equal(
    await fetchTrainingCompletedTime(42), null,
    'an empty mandatory set means someone cleared the catalogue flags; failing\n'
    + '  OPEN would unlock earning platform-wide, which is the worse wrong answer',
  );
});

test('a mandatory course with ONLY an assessment can still complete the gate', async () => {
  // The shape production actually has if the global videos were ever demoted:
  // no mandatory videos, one mandatory assessment, passed.
  videos = { total: 0, done: 0, last_done: null };
  nonVideo = { total: 1, done: 1, last_done: ASSESS_STAMP };

  assert.equal(
    await fetchTrainingCompletedTime(42), ASSESS_STAMP,
    'the non-video half must be able to satisfy the gate ALONE — otherwise the\n'
    + '  empty-set branch swallows it and a fully trained technician stays locked',
  );
});

test('the non-video query is scoped to MANDATORY courses, not every assigned one', async () => {
  videos = { total: 3, done: 3, last_done: VIDEO_STAMP };
  nonVideo = { total: 0, done: 0, last_done: null };
  await fetchTrainingCompletedTime(42);

  const call = fake.calls.find((c) => /FROM easyfixer_courses ec/i.test(c.sql));
  assert.ok(call, 'the non-video half must actually run — a missing query reads as "nothing pending"');
  assert.match(call.sql, /c\.is_mandatory = 1/,
    'isTrainingComplete covers EVERY assigned course; reusing that scope here would\n'
    + '  make an optional course block job access');
  assert.match(call.sql, /lc\.kind <> 'video'/,
    'videos are counted by the other half; counting them twice would double `total`');
  assert.match(call.sql, /c\.status = 1[\s\S]*lc\.status = 1|lc\.status = 1[\s\S]*c\.status = 1/,
    'a retired course or item must stop gating work');
});

console.log('training gate: mandatory content, not just mandatory videos');
