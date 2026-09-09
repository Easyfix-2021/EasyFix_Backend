/*
 * `GET /api/mobile/training-videos` must carry each video's watched-%.
 *
 * THE BUG. The response projected no progress at all. Every client that does
 * not separately call `GET /training-videos/percentage` therefore read 0 for
 * every video — and the technician dashboard's training card does exactly
 * that: it picks the first row under 100% and offers it. With the whole list
 * pinned at 0 it offered video #1 forever, however many times that video had
 * been watched to the end.
 *
 * THE TRAP THE FIX HAD TO CLEAR. The statement already interpolated
 * `visibleVideoIdsSql()`, which contributes TWO placeholders; the progress
 * LEFT JOIN adds a third, and it is written BEFORE the WHERE clause, so it
 * takes the FIRST bind. mysql2 substitutes `?` positionally and client-side, so
 * a bind count that does not match leaves a literal `?` in the statement and
 * MySQL rejects the whole thing — which is precisely how every technician's
 * training list came back empty in production on 2026-08-31.
 * tests/mobile-query-bind-arity.test.js pins that arity statically for every
 * route; this asserts it at RUNTIME for this one, alongside the projection
 * itself, so the SQL is proved to be both accepted and correct.
 *
 * Runner: `node --test tests/mobile-training-videos-watched.test.js`.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');

const TECH = { efr_id: 7, user_id: 9001 };

/*
 * Two videos and no more: one the technician is part-way through, one they have
 * never opened (no `easyfixer_watched_video` row at all, which is what the
 * COALESCE is for). A single row could not tell "the join works" apart from "a
 * constant is being returned".
 */
const VIDEO_ROWS = [
  {
    id: 31,
    title: 'Electrical Safety',
    description: 'd1',
    sub_title: 's1',
    sub_description: 'sd1',
    doc_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    watched_percentage: 100,
  },
  {
    id: 12,
    title: 'Ladder Safety',
    description: 'd2',
    sub_title: 's2',
    sub_description: 'sd2',
    doc_url: 'https://www.youtube.com/watch?v=aQw4w9WgXcQ',
    // No progress row → the LEFT JOIN yields NULL and COALESCE must make it 0.
    watched_percentage: null,
  },
];

// Every flag column present, so `visibleVideoIdsSql()` builds its REAL two-bind
// form rather than the degraded `1=0` one — the degraded form still has the two
// placeholders, but a test that only ever exercised it would not notice if that
// stopped being true.
const FLAG_COLUMNS = [
  { t: 'courses', c: 'is_mandatory' },
  { t: 'training_videos', c: 'is_global' },
  { t: 'lms_assessment', c: 'created_by' },
];

let trainingQuery = null;

const fake = installFakePool([
  [/information_schema\.columns/i, FLAG_COLUMNS],
  [
    /FROM training_videos tv/i,
    (sql, params) => {
      trainingQuery = { sql, params };
      return VIDEO_ROWS;
    },
  ],
]);

// Auth + the guards this route does not exercise, stubbed before the router
// captures them.
for (const [mod, exports] of [
  ['../middleware/tech-auth', (req, _res, next) => { req.tech = { ...TECH }; next(); }],
  ['../middleware/require-tech-lifecycle-capability', {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  }],
  ['../middleware/idempotency', () => (_req, _res, next) => next()],
]) {
  require.cache[require.resolve(mod)] = {
    id: require.resolve(mod),
    filename: require.resolve(mod),
    loaded: true,
    exports,
  };
}

let server;
let baseUrl;

before(async () => {
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
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fake.restore) fake.restore();
});

async function listVideos() {
  const r = await fetch(`${baseUrl}/mobile/training-videos`);
  return { status: r.status, body: await r.json() };
}

test('each video carries its own watched percentage', async () => {
  const res = await listVideos();
  assert.equal(res.status, 200);
  const byId = new Map(res.body.data.map((v) => [v.id, v]));
  assert.equal(byId.get(31).watchedPercentage, 100,
    'a fully watched video must say so — this is the value the dashboard card reads');
  assert.equal(byId.get(12).watchedPercentage, 0,
    'a never-opened video has no progress row; NULL must surface as 0, not undefined');
});

test('progress is joined for the CALLING technician, not for everyone', async () => {
  await listVideos();
  assert.ok(trainingQuery, 'the training-videos query never ran');
  assert.match(
    trainingQuery.sql.replace(/\s+/g, ' '),
    /LEFT JOIN easyfixer_watched_video wv ON wv\.video_id = tv\.id AND wv\.easyfixer_id = \?/i,
    'progress must be scoped by a BOUND easyfixer_id — an unscoped join would '
    + "show one technician another's progress",
  );
});

test('every placeholder in the statement has a bind behind it', async () => {
  await listVideos();
  const placeholders = (trainingQuery.sql.match(/\?/g) || []).length;
  assert.equal(placeholders, 3,
    'one for the progress join, two for visibleVideoIdsSql()');
  assert.deepEqual(trainingQuery.params, [TECH.efr_id, TECH.efr_id, TECH.efr_id],
    'a surplus `?` survives into the statement and MySQL rejects it, emptying '
    + 'the list for every technician');
});
