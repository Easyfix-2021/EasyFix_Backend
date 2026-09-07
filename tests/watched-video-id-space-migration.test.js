const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readMigration } = require('./helpers/migration-file');

/*
 * migrations/2026-09-07-canonicalise-watched-video-id-space.sql moves the five
 * easyfixer_watched_video rows whose video_id holds a `training_video_id`
 * (the FK into `document`) into the `training_videos.id` space every reader
 * actually uses.
 *
 * The SQL cannot be executed here — MyISAM, a live shared DB, and the repo
 * does not run migrations in tests. What IS checkable, and what actually
 * corrupts data when it breaks, is the file's structure: the guard that keeps
 * the rewrite off valid modern ids, and the statement ORDER that keeps the
 * remap from colliding with the unique key. Both are one edit away from
 * silently destroying live progress, and neither shows up in a status check.
 */
const sql = readMigration('2026-09-07-canonicalise-watched-video-id-space.sql');

/** Statement bodies, comments stripped, in file order. */
const statements = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

test('every write is fenced off from ids that are already canonical', () => {
  assert.equal(statements.length, 3, 'expected exactly MERGE, DELETE, REMAP');
  for (const [i, stmt] of statements.entries()) {
    assert.match(
      stmt,
      /NOT EXISTS\s*\(\s*SELECT 1 FROM training_videos c WHERE c\.id = \w+\.video_id\s*\)/,
      `statement ${i + 1} may rewrite rows whose video_id is a real `
      + 'training_videos.id — that is live progress, not a stray',
    );
  }
});

test('the merge runs before the remap, or the remap hits the unique key', () => {
  const [merge, del, remap] = statements;
  assert.match(merge, /^UPDATE easyfixer_watched_video keep/);
  assert.match(merge, /SET keep\.watched_percentage = GREATEST\(/);
  assert.match(del, /^DELETE stray/);
  assert.match(remap, /^UPDATE easyfixer_watched_video stray/);
  assert.match(remap, /SET stray\.video_id = tv\.id/);
});

test('the remap resolves through training_video_id, not through id', () => {
  const remap = statements[2];
  assert.match(remap, /JOIN training_videos tv\s+ON tv\.training_video_id = stray\.video_id/);
  assert.doesNotMatch(
    remap,
    /ON tv\.id = stray\.video_id/,
    'joining on tv.id would map every stray onto itself and change nothing',
  );
});

test('the merge only ever raises watched_percentage', () => {
  // trg_easyfixer_watched_video_monotonic would clamp a lowering UPDATE
  // silently, so a merge that could lower must not exist in the first place.
  assert.match(statements[0], /GREATEST\(\s*COALESCE\(keep\.watched_percentage, 0\),\s*COALESCE\(stray\.watched_percentage, 0\)\s*\)/);
  assert.doesNotMatch(statements[0], /LEAST\(/);
});

test('house migration style: no session variables, no PREPARE', () => {
  assert.doesNotMatch(sql, /^\s*SET\s+@/mi);
  assert.doesNotMatch(sql, /\bPREPARE\b|\bEXECUTE\b|\bDEALLOCATE\b/i);
});
