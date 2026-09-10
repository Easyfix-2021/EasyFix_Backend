/*
 * Unit tests for scripts/dead-exports.js — the two PURE halves of the
 * dead-export sweep, and the only parts that can regress silently.
 *
 * WHY THESE TWO AND NOT THE WHOLE SWEEP. The classification is
 * `exportedNames()` (what does this file export?) and `internalUses()` (does it
 * use the name itself?). Get either wrong and the sweep still runs, still exits
 * 0, and still prints a confident list — just the wrong one. The git/DB-free
 * split mirrors scripts/migration-status.js, whose tests cover artifactsOf for
 * exactly the same reason.
 *
 * BOTH FAILURES BELOW ARE REAL, from the day this was written:
 *
 *   1. internalUses() first counted raw text occurrences. For
 *        const STAGE_LABELS = Object.freeze({...});
 *        module.exports = { …, STAGE_LABELS };
 *      that is already 2 with zero actual uses, so EVERY dead export was
 *      mis-binned as "used internally" and the sweep reported 5 instead of 32.
 *
 *   2. The TypeScript sibling had no internal-use notion at all and reported 8
 *      plainly-used exports from portal-markers.ts as unreferenced.
 *
 * Neither was found by reading the code. Both were found by running the tool
 * against an export whose answer was already known.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exportedNames, internalUses } = require('../scripts/dead-exports');

/** Classify one single-file source the way the sweep does, ignoring the corpus. */
function classifyAlone(code, name) {
  const parsed = exportedNames(code);
  assert.ok(parsed, 'source must parse');
  assert.ok(parsed.names.includes(name), `${name} must be seen as an export`);
  return internalUses(parsed.ast, parsed.exportRanges, name) > 0 ? 'internal-only' : 'dead';
}

// ─── exportedNames ────────────────────────────────────────────────────────
test('the three module.exports shapes are all recognised', () => {
  assert.deepEqual(exportedNames('const a = 1;\nmodule.exports = { a };').names, ['a']);
  assert.deepEqual(exportedNames('module.exports.b = 2;').names, ['b']);
  assert.deepEqual(exportedNames('exports.c = 3;').names, ['c']);
});

test('a renamed export is keyed by the EXPORTED name, not the local one', () => {
  // db.js does exactly this: `_poolLimit: poolLimit`. Keying on the local name
  // would search the corpus for the wrong identifier and call it live.
  assert.deepEqual(exportedNames('const poolLimit = 1;\nmodule.exports = { _poolLimit: poolLimit };').names,
    ['_poolLimit']);
});

test('a module exporting a single function has no NAMED exports', () => {
  // routers do `module.exports = router` — there is nothing here to sweep, and
  // inventing a name would flag every route file in the repo.
  assert.deepEqual(exportedNames('const router = {};\nmodule.exports = router;').names, []);
});

test('unparseable source returns null — never an empty list', () => {
  // The difference matters: [] means "parsed, exports nothing" and is silently
  // dropped; null is reported as UNPARSEABLE. A parser that failed and a file
  // that exports nothing must never look the same.
  assert.equal(exportedNames('const = ;'), null);
});

// ─── internalUses ─────────────────────────────────────────────────────────
test('declare + export with no other mention is DEAD, not internal-only', () => {
  /*
   * THE REGRESSION THIS FILE EXISTS FOR. This is the STAGE_LABELS shape
   * verbatim. A text count says 2; the answer is 0.
   */
  const code = "const STAGE_LABELS = Object.freeze({ a: 'A' });\nmodule.exports = { STAGE_LABELS };";
  assert.equal(classifyAlone(code, 'STAGE_LABELS'), 'dead');
});

test('a name the file actually uses is INTERNAL-ONLY, not dead', () => {
  // The positive control for the test above: a filter that returned 0 for
  // everything would pass that one and be undetectable without this.
  const code = "const M = 'x';\nconst S = `[${M}]`;\nmodule.exports = { M, S };";
  assert.equal(classifyAlone(code, 'M'), 'internal-only',
    'M builds S, so it is used — the portal-markers.ts shape');
  assert.equal(classifyAlone(code, 'S'), 'dead');
});

test('a matching PROPERTY KEY is not a use of the exported name', () => {
  // `{ total: 1 }` must not make an export named `total` look used, or every
  // common word becomes permanently live.
  const code = "const total = 1;\nconst row = { total: 99 };\nmodule.exports = { total, row };";
  assert.equal(classifyAlone(code, 'total'), 'dead');
});

test('a matching MEMBER access is not a use either', () => {
  const code = "const limit = 1;\nconst o = {};\nconst x = o.limit;\nmodule.exports = { limit, o, x };";
  assert.equal(classifyAlone(code, 'limit'), 'dead');
});

test('a function called by another function in the same file is internal-only', () => {
  const code = 'function helper() { return 1; }\nfunction top() { return helper(); }\n'
    + 'module.exports = { helper, top };';
  assert.equal(classifyAlone(code, 'helper'), 'internal-only');
});

// ─── the corpus check that keeps the classifier honest ────────────────────
test('over the real repo the classifier is not flagging everything', () => {
  /*
   * DENOMINATOR. A classifier that answered "dead" too readily would produce a
   * long, confident, useless list; one that answered "live" too readily would
   * produce an empty one and look like a clean repo. Measured when written:
   * 2005 exports, ~8% flagged. The bound is deliberately loose — this guards
   * against a redesign-scale regression, not against normal drift.
   */
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'services');
  let total = 0; let dead = 0; let parsed = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    const p = exportedNames(code);
    if (!p) continue;
    parsed += 1;
    for (const n of p.names) {
      total += 1;
      if (internalUses(p.ast, p.exportRanges, n) === 0) dead += 1;
    }
  }
  assert.ok(parsed > 100, `expected the real services corpus; parsed only ${parsed} files`);
  assert.ok(total > 300, `expected plenty of exports; found ${total}`);
  // "no internal use" is a superset of DEAD (the corpus half narrows it further),
  // so this bound is generous by construction.
  assert.ok(dead < total * 0.75,
    `${dead} of ${total} exports have no internal use — the classifier has stopped discriminating`);
  assert.ok(dead > 0, 'positive control: zero would mean internalUses never returns 0');
});
