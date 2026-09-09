'use strict';
/*
 * Which easyfix_properties keys does the code ask for that this database does
 * not have?
 *
 * WHY THIS EXISTS. getProperty() returns undefined for a key with no row, and
 * every caller treats undefined as "off" or falls back to a code default. That
 * is the right behaviour — a missing row must never crash a boot — but it means
 * a key that was never created is indistinguishable from a feature someone
 * deliberately switched off. On 2026-09-09 a nightly cron shipped gated on
 * `pincode.serviceable_recompute.enabled` with no migration to create the row:
 * the gate read false, the job logged SKIPPED, and its skipReason told an
 * operator to set a property that had no row to set. Nothing was wrong in the
 * logs. It surfaced only when a human went looking for the switch.
 *
 * ─── TWO BUCKETS, BECAUSE THEY HAVE DIFFERENT FIXES ────────────────────────
 *
 * A flat list of "missing keys" would be useless here: 62 keys are referenced
 * and 8 are absent on QA today, most of them harmless (a tuning value with a
 * code default needs no row at all). A warning that fires on all 8 every boot
 * is wallpaper within a week. So they are split by what you would DO:
 *
 *   NOT SEEDED  — referenced in code, and no migration anywhere creates it.
 *                 Nobody ever wrote the row. This is the bug above; the fix is
 *                 a seed migration.
 *   NOT APPLIED — a migration creates it, but this database has no row. The
 *                 migration has not run here. The fix is to run it.
 *
 * ─── WHY IT WARNS AND NEVER THROWS ─────────────────────────────────────────
 *
 * Making a missing row fatal would convert a benign gap — a tuning key with a
 * default, a feature legitimately not configured in this environment — into a
 * refusal to boot. That trades a silent, recoverable problem for an outage,
 * which is a worse failure than the one being fixed. It reports; a human
 * decides.
 */
const fs = require('fs');
const path = require('path');

/* Directories with no bearing on runtime configuration. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'coverage', 'tests', 'docs']);

/*
 * Pure-literal reads only — a call whose single argument is a quoted key and
 * which closes immediately. BOTH quote styles: the first draft matched only
 * single quotes, and the acorn cross-check in tests/property-key-audit.test.js
 * caught a double-quoted call it could not see. That is the cross-check doing
 * exactly the job it exists for.
 *
 * A concatenated call, where the literal is followed by `+` and a variable,
 * builds its key at runtime; the literal is a PREFIX and no row will ever
 * carry it verbatim. Capturing those would report a permanent false positive
 * nobody can fix, which is how a check teaches people to ignore it. There is
 * exactly one such call site today and it is deliberately not audited.
 *
 * WHY REGEX AND NOT A PARSER. This runs at server BOOT, and the production
 * image is built with `npm ci --omit=dev` — acorn (used by
 * scripts/scan-unguarded-await.js for exactly this kind of scan) is a
 * transitive DEV dependency and is not installed there. An AST scan would be
 * exact in CI and silently unavailable in production, which is precisely the
 * quiet-degradation failure this module exists to catch. So: a cheap scanner
 * here, cross-checked against the real parser by
 * tests/property-key-audit.test.js, where acorn is present.
 *
 * The regex cost is that it cannot tell code from prose — the first run of
 * this module reported `a.b.c` from its own doc comment. Comments are
 * therefore stripped before matching, and this file is skipped outright.
 *
 * matchAll() rather than a shared /g literal with .test(): the latter carries
 * lastIndex between files and silently skips matches.
 */
const PURE_READ = /getProperty\(\s*(['"])([^'"]+)\1\s*\)/g;
const DYNAMIC_READ = /getProperty\(\s*(['"])([^'"]+)\1\s*\+/g;

function walk(dir, out, exts) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out, exts);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/*
 * Strip comments so documentation about getProperty is not mistaken for a
 * call. Block comments go wholesale. Line comments only where `//` is not
 * preceded by `:`, so a URL inside a string ('https://…') keeps the rest of
 * its line — mangling that could delete a REAL call sharing the line.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every property key the code reads by string literal. */
function referencedKeys(root) {
  const keys = new Set();
  const dynamicPrefixes = new Set();
  for (const file of walk(root, [], ['.js', '.mjs'])) {
    if (path.resolve(file) === __filename) continue;  // this file documents the pattern
    const raw = readSafe(file);
    if (!raw.includes('getProperty(')) continue;
    const src = stripComments(raw);
    for (const m of src.matchAll(PURE_READ)) keys.add(m[2]);
    for (const m of src.matchAll(DYNAMIC_READ)) dynamicPrefixes.add(m[2]);
  }
  return { keys, dynamicPrefixes };
}

/*
 * Every key some migration creates — pending or executed, both directories.
 * Matched as a quoted literal rather than a bare substring, so a key that is
 * merely NAMED in a comment ("see also foo.enabled") does not count as seeded.
 */
function seededKeys(root) {
  const keys = new Set();
  for (const file of walk(path.join(root, 'migrations'), [], ['.sql'])) {
    for (const m of readSafe(file).matchAll(/'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/gi)) keys.add(m[1]);
  }
  return keys;
}

/**
 * @param {object}  o
 * @param {string}  o.root       repo root to scan
 * @param {Iterable<string>} o.presentKeys  keys this database actually has
 * @returns {{referenced:number, notSeeded:string[], notApplied:string[], dynamicPrefixes:string[]}}
 */
function auditPropertyKeys({ root, presentKeys }) {
  const { keys, dynamicPrefixes } = referencedKeys(root);
  const present = presentKeys instanceof Set ? presentKeys : new Set(presentKeys);
  const seeded = seededKeys(root);

  const notSeeded = [];
  const notApplied = [];
  for (const k of keys) {
    if (present.has(k)) continue;
    (seeded.has(k) ? notApplied : notSeeded).push(k);
  }
  notSeeded.sort();
  notApplied.sort();
  return {
    referenced: keys.size,
    notSeeded,
    notApplied,
    dynamicPrefixes: [...dynamicPrefixes].sort(),
  };
}

module.exports = { auditPropertyKeys, referencedKeys, seededKeys, stripComments };
