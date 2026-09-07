'use strict';
/*
 * THE TEST SUITE MUST RUN IN UTC, EVERYWHERE.
 *
 * WHY THIS EXISTS. mobile-dashboard's isTodaysWork() converted a DATETIME that
 * was ALREADY IST (db.js sets dateStrings:true) as though it were server-local,
 * then re-converted it to IST. Two errors that cancel out only when the server
 * runs in IST — which every developer machine here does, and which the
 * container does not. Under UTC, an 18:53 IST check-in was dated to the next
 * day and the job silently left "Today's Jobs".
 *
 * The suite could not catch it. Locally it ran in IST, where the bug is
 * invisible. In CI it ran in UTC, where it is visible — but the assertion built
 * its fixture from Date.now(), so it only failed while the IST clock was past
 * 18:30. It passed a deploy at 10:24 UTC and failed one at 13:11 UTC with no
 * code change in between; 13:00 UTC is 18:30 IST.
 *
 * So the timezone is pinned in three places and this file checks all three.
 * Derived from package.json and the workflow files rather than hand-listed —
 * a script added tomorrow is covered without anyone remembering this test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** A script RUNS tests if it invokes the node test runner, however indirectly. */
const runsTests = (cmd) => /node --test\b/.test(cmd) || /test-no-skips/.test(cmd);

test('every npm script that runs tests pins TZ=UTC', () => {
  const unpinned = Object.entries(pkg.scripts)
    .filter(([, cmd]) => runsTests(cmd) && !/\bTZ=UTC\b/.test(cmd))
    .map(([name]) => name);
  assert.deepEqual(unpinned, [],
    'these run the suite in the developer\'s local zone, so they answer a '
    + 'different question than CI does — prefix each with TZ=UTC');
});

test('the guard is not vacuous — it can actually see the scripts', () => {
  /*
   * Without this, a typo in `runsTests` would make the check above pass by
   * matching nothing, and report a clean run while enforcing nothing. The
   * repo has been bitten by exactly that shape before.
   */
  const matched = Object.entries(pkg.scripts).filter(([, c]) => runsTests(c));
  assert.ok(matched.length >= 5,
    `only ${matched.length} test-running scripts detected — the matcher has stopped seeing them`);
  assert.ok(matched.some(([n]) => n === 'test'), 'the main `test` script must be among them');
});

test('both CI workflows DECLARE the timezone rather than inheriting it', () => {
  // A github-hosted runner is UTC today. The point of pinning is that the suite
  // must not depend on where it runs, so the value is stated in the file.
  for (const wf of ['ci.yml', 'deploy.yml']) {
    const p = path.join(ROOT, '.github', 'workflows', wf);
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, 'utf8');
    assert.match(body, /^env:\s*$[\s\S]{0,200}^\s+TZ:\s*UTC\s*$/m,
      `${wf} must set a top-level env: TZ: UTC`);
  }
});

test('and the process this test runs in is actually UTC', () => {
  /*
   * The end-to-end check: whatever the config says, THIS run must be UTC. It
   * fails loudly for anyone invoking `node --test` directly instead of through
   * the npm script — which is how the original bug was missed all session.
   */
  assert.equal(new Date().getTimezoneOffset(), 0,
    'run the suite via `npm test` (or prefix TZ=UTC) — a local-zone run cannot '
    + 'see date bugs that only appear in the container');
});
