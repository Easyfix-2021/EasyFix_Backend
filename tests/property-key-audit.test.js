'use strict';
/*
 * lib/property-key-audit.js — the boot-time report of property keys the code
 * reads that this database has no row for.
 *
 * BACKGROUND (2026-09-09). A nightly cron shipped gated on
 * `pincode.serviceable_recompute.enabled` with no migration creating the row.
 * getProperty() returns undefined for an absent key, every caller reads that
 * as "off", and the job logged SKIPPED — correct behaviour, and identical to a
 * feature somebody switched off on purpose. Nothing in the logs was wrong. It
 * surfaced only when a human went looking for a switch that did not exist.
 * Eight other referenced keys turned out to be missing on QA at the same time.
 *
 * ─── THE LOAD-BEARING TEST IN THIS FILE ────────────────────────────────────
 *
 * The scanner is a REGEX, deliberately: it runs at server boot, and the
 * production image is built with `npm ci --omit=dev`, so acorn — which
 * scripts/scan-unguarded-await.js uses for this kind of scan — is not
 * installed there. A parser-based audit would be exact in CI and silently
 * absent in production, which is the very quiet-degradation failure the module
 * exists to catch.
 *
 * That trade is only safe if the cheap scanner actually agrees with a real
 * parser. So the last test parses the whole repo with acorn (available HERE,
 * in dev) and asserts the two agree exactly. If someone writes a call shape
 * the regex cannot see, this fails in CI rather than going quiet in prod.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  auditPropertyKeys, referencedKeys, seededKeys, stripComments,
} = require(path.join(ROOT, 'lib/property-key-audit'));

/* ─── comment stripping ────────────────────────────────────────────────── */

test('prose about getProperty is not mistaken for a call', () => {
  /*
   * The exact defect the first run of this module produced: it scanned its own
   * documentation and reported `a.b.c` as a missing property key. A checker
   * that invents findings is worse than no checker — the first thing anyone
   * does with a false positive is learn to skim past the whole report.
   */
  const src = [
    '/* Pure-literal reads only, e.g. getProperty(\'doc.only.key\') closed. */',
    "// also getProperty('line.comment.key')",
    "const real = getProperty('real.key');",
  ].join('\n');
  const stripped = stripComments(src);
  assert.ok(!stripped.includes('doc.only.key'), 'block comment must be stripped');
  assert.ok(!stripped.includes('line.comment.key'), 'line comment must be stripped');
  assert.ok(stripped.includes('real.key'), 'the actual call must survive');
});

test('a URL in a string does not eat the rest of its line', () => {
  // The risk in stripping `//` to end-of-line: 'https://x' would truncate the
  // line and could delete a REAL call sharing it. Guarded by requiring the
  // `//` not to be preceded by a colon.
  const src = "const u = 'https://example.com/x'; const v = getProperty('kept.key');";
  assert.ok(stripComments(src).includes('kept.key'));
});

/* ─── bucketing ────────────────────────────────────────────────────────── */

test('a referenced key is bucketed by WHAT YOU WOULD DO about it', () => {
  /*
   * Two buckets rather than one list, because the fixes differ and a flat
   * "missing" list is mostly benign: several referenced keys are tuning values
   * with code defaults that need no row at all. A warning firing on all of
   * them every boot is wallpaper inside a week.
   */
  const present = new Set(referencedKeys(ROOT).keys);
  const seeded = seededKeys(ROOT);

  // Pick a real key that a migration creates, and pretend the DB lacks it.
  const seededAndReferenced = [...present].find((k) => seeded.has(k));
  assert.ok(seededAndReferenced, 'expected at least one referenced key with a seed migration');
  present.delete(seededAndReferenced);

  const a = auditPropertyKeys({ root: ROOT, presentKeys: present });
  assert.ok(a.notApplied.includes(seededAndReferenced),
    'a key whose migration exists but has not run here is NOT APPLIED — run the migration');
  assert.ok(!a.notSeeded.includes(seededAndReferenced),
    'it must not be reported as never-created; that would send someone to write a duplicate migration');
});

test('a key nothing creates is reported as NOT SEEDED', () => {
  const a = auditPropertyKeys({ root: ROOT, presentKeys: [] });
  assert.ok(a.notSeeded.length > 0, 'with an empty database, unseeded keys must surface');
  for (const k of a.notSeeded) {
    assert.ok(!seededKeys(ROOT).has(k), `${k} is seeded by a migration and must be NOT APPLIED instead`);
  }
});

test('a fully-configured database reports nothing', () => {
  // The negative control. Without it, an audit that always reports something
  // would pass every test above.
  const all = referencedKeys(ROOT).keys;
  const a = auditPropertyKeys({ root: ROOT, presentKeys: all });
  assert.deepEqual(a.notSeeded, []);
  assert.deepEqual(a.notApplied, []);
});

test('a concatenated key is excluded — its literal is a prefix, not a key', () => {
  const { dynamicPrefixes, keys } = referencedKeys(ROOT);
  assert.ok(dynamicPrefixes.size > 0, 'the repo still has at least one runtime-built key');
  for (const p of dynamicPrefixes) {
    assert.ok(!keys.has(p),
      `${p} is a prefix built at runtime; no row will ever carry it verbatim, so reporting it `
      + 'would be a permanent finding nobody can fix');
  }
});

/* ─── the cross-check that justifies using a regex at all ──────────────── */

test('the boot scanner agrees EXACTLY with an acorn parse of the whole repo', () => {
  /*
   * acorn is a transitive DEV dependency — present here, absent from the
   * production image (`npm ci --omit=dev`), which is why the runtime scanner
   * cannot use it. This test is where the exact parser earns its keep: it
   * proves the cheap scanner sees every call the real parser sees, so the
   * production audit is not quietly missing shapes.
   */
  let acorn;
  try { acorn = require('acorn'); } catch { assert.fail('acorn must be available in dev to cross-check the scanner'); }

  const SKIP = new Set(['node_modules', '.git', '.github', 'coverage', 'tests', 'docs']);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) files.push(path.join(dir, e.name));
    }
  }(ROOT));

  const AUDIT_MODULE = path.join(ROOT, 'lib', 'property-key-audit.js');
  const fromAst = new Set();
  let parsed = 0;
  let failed = 0;

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const name = callee && (callee.name || (callee.property && callee.property.name));
      if (name === 'getProperty' && node.arguments.length >= 1) {
        const arg = node.arguments[0];
        // Only a bare string literal is a real key; a BinaryExpression builds
        // one at runtime and its literal half is a prefix.
        if (arg.type === 'Literal' && typeof arg.value === 'string') fromAst.add(arg.value);
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      visit(node[k]);
    }
  };

  for (const f of files) {
    if (path.resolve(f) === AUDIT_MODULE) continue;   // same exclusion the scanner makes
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('getProperty(')) continue;
    try {
      visit(acorn.parse(src, {
        ecmaVersion: 'latest',
        sourceType: f.endsWith('.mjs') ? 'module' : 'script',
        allowReturnOutsideFunction: true,
      }));
      parsed += 1;
    } catch { failed += 1; }
  }

  /*
   * Guard the guard. If every file failed to parse, `fromAst` would be empty
   * and an equality assertion against it could pass vacuously — the shape of
   * "a broken checker reports zero findings and looks green".
   */
  assert.ok(parsed > 5, `only ${parsed} files parsed (${failed} failed) — the cross-check is vacuous`);
  assert.equal(failed, 0, 'every file containing getProperty must parse');

  const fromRegex = referencedKeys(ROOT).keys;
  const missedByRegex = [...fromAst].filter((k) => !fromRegex.has(k)).sort();
  const inventedByRegex = [...fromRegex].filter((k) => !fromAst.has(k)).sort();

  assert.deepEqual(missedByRegex, [],
    'the boot scanner missed a call the parser found — a call shape it cannot see means the '
    + 'production audit is silently incomplete, which is the failure this module exists to prevent');
  assert.deepEqual(inventedByRegex, [],
    'the boot scanner reported a key the parser does not — a false finding trains people to '
    + 'ignore the whole report');
});
