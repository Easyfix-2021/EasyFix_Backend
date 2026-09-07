#!/usr/bin/env node
/**
 * Every column our SQL names, checked against the live INFORMATION_SCHEMA.
 * Read-only.
 *
 * WHY THIS EXISTS ALONGSIDE scripts/schema-verify.js. That file checks a
 * HAND-MAINTAINED list of tables and columns, so it only protects what somebody
 * remembered to add — and on 2026-08-27 two phantom-column bugs shipped past it
 * because the columns were never listed:
 *
 *   Supply Gap        selected six tbl_user columns from tbl_easyfixer and
 *                     500'd the report on every environment.
 *   Technician ratings selected `id` from a table whose key is `table_id`. That
 *                     one was CAUGHT and swallowed, so every technician's
 *                     Ratings screen returned an empty list — permanently, with
 *                     one warn line and no error anywhere.
 *
 * This derives the list from the SQL ITSELF, so a query cannot name a column
 * without being checked. Nothing to remember, nothing to keep in sync.
 *
 * TWO SHAPES, because they fail differently:
 *   alias.column   — resolved per QUERY, never per file. Aliases collide across
 *                    queries in one file (TC is tbl_client here and tbl_city
 *                    there), and a file-wide map invents phantom findings.
 *   bare column    — only for a query reading exactly ONE table with no alias.
 *                    This is the Supply Gap shape and the alias pass is blind
 *                    to it.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const ROOT = path.join(__dirname, '..');

const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^\s*\/\/.*$/gm, '');

/*
 * Words that can follow a table name and are NOT an alias.
 *
 * Getting this list wrong is not cosmetic. The first version of this script
 * omitted WHERE, so `FROM tbl_easyfixer WHERE …` read "WHERE" as the alias,
 * concluded the query was alias-scoped, and skipped it — coming back clean on
 * the very bug it was written to find. It is only a checker if it fails on that
 * input, which tests/phantom-column-verifier.test.js pins.
 */
const NOT_AN_ALIAS = new Set([
  'on', 'using', 'where', 'group', 'order', 'limit', 'set', 'values', 'union',
  'left', 'right', 'inner', 'outer', 'join', 'having', 'for', 'as', 'and', 'or',
  'offset', 'straight_join', 'natural', 'cross', 'lateral',
]);

const SELECT_KEYWORDS = new Set([
  'select', 'distinct', 'from', 'as', 'and', 'or', 'not', 'null', 'is', 'in',
  'where', 'order', 'by', 'group', 'limit', 'all', 'case', 'when', 'then',
  'else', 'end', 'asc', 'desc', 'true', 'false',
]);

/*
 * ${...} interpolations are BLANKED before scanning.
 *
 * What is inside them is JavaScript, not literal SQL, and it is conditional by
 * construction — the drift-tolerant pattern this codebase uses for optional
 * columns looks like:
 *
 *   ${hasCityNameCol ? 'e.city_name' : 'c.city_name AS city_name'}
 *
 * Reading that as literal SQL reports `e.city_name` as a phantom on a
 * deployment that does not have it, which is precisely the case the code
 * already handles. Flagging a working guard is how a checker gets allowlisted
 * into uselessness.
 *
 * THE COST, stated plainly: a WHERE fragment assembled in a JS string and
 * interpolated later is invisible here. That is real — client-tech-mapping's
 * `clauses.push('e.city_id = ?')` was a genuine phantom this scan could not
 * see, and it was found by reading. This checks literal SQL; it does not
 * replace reading the code.
 */
function sqlLiterals(src) {
  return [...src.matchAll(/`([^`]*)`/g)]
    .map((m) => m[1].replace(/\$\{[^}]*\}/g, ' '))
    .filter((b) => /\bSELECT\b/i.test(b));
}

function aliasMap(body) {
  const m = new Map();
  const re = /\b(?:FROM|JOIN)\s+`?([a-z_][a-z0-9_]*)`?\s+(?:AS\s+)?([A-Za-z][A-Za-z0-9_]*)/gi;
  for (const x of body.matchAll(re)) {
    if (NOT_AN_ALIAS.has(x[2].toLowerCase())) continue;
    m.set(x[2], x[1].toLowerCase());
  }
  return m;
}

/* Aliases that name a SUBQUERY — their "columns" are projections, not base columns. */
function derivedAliases(body) {
  return new Set([...body.matchAll(/\)\s*(?:AS\s+)?([A-Za-z][A-Za-z0-9_]*)/gi)].map((m) => m[1]));
}

/*
 * SQL fragments assembled as JS STRINGS and interpolated later:
 *
 *   clauses.push('e.city_id = ?');            <- a real phantom, and invisible
 *   where.push('(rc.status IS NULL)');           to the literal-SQL scan above
 *   ...
 *   `SELECT … WHERE ${clauses.join(' AND ')}`
 *
 * The alias is bound in the TEMPLATE, not in the fragment, so the fragment
 * cannot be resolved on its own. It is resolved against the FILE's aliases
 * instead — and conservatively: an alias bound to several tables across the
 * file only counts as a phantom when the column is missing from ALL of them.
 *
 * That conservatism is deliberate. A file-wide alias map used for LITERAL SQL
 * invented 17 findings on this codebase's first run, every one an artifact of
 * an alias meaning different things in different queries. Requiring the column
 * to be absent everywhere the alias could point removes that whole class, at
 * the cost of missing a fragment whose column happens to exist on some other
 * table the same letter names elsewhere. Under-reporting beats crying wolf.
 */
function fileAliasTables(src) {
  const m = new Map();
  const re = /\b(?:FROM|JOIN|UPDATE)\s+`?([a-z_][a-z0-9_]*)`?\s+(?:AS\s+)?([A-Za-z][A-Za-z0-9_]*)/gi;
  for (const x of src.matchAll(re)) {
    if (NOT_AN_ALIAS.has(x[2].toLowerCase())) continue;
    if (!m.has(x[2])) m.set(x[2], new Set());
    m.get(x[2]).add(x[1].toLowerCase());
  }
  return m;
}

/* Does this line put the string in a ternary? That is the guarded pattern. */
function isTernaryBranch(line) {
  return /\?[^?]*['"][^'"]*['"]\s*:/.test(line) || /:\s*['"][^'"]*['"]/.test(line);
}

function jsFragmentFindings(rel, src, cols) {
  const out = [];
  const aliases = fileAliasTables(src);
  if (!aliases.size) return out;
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (isTernaryBranch(line)) return;               // probed / conditional
    for (const str of line.matchAll(/'([^']{3,200})'|"([^"]{3,200})"/g)) {
      const frag = str[1] || str[2];
      // Only strings that read as SQL: a comparison, or a SQL operator.
      if (!/[=<>]|\bIS\b|\bLIKE\b|\bIN\b|\bNOT\b/i.test(frag)) continue;
      for (const ref of frag.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
        const [, alias, col] = ref;
        const tables = aliases.get(alias);
        if (!tables) continue;
        const known = [...tables].filter((t) => cols.has(t));
        if (!known.length) continue;
        if (known.some((t) => cols.get(t).has(col.toLowerCase()))) continue;
        out.push({
          rel, kind: 'js-fragment', ref: `${alias}.${col}`,
          table: known.join('|'), col, line: i + 1,
        });
      }
    }
  });
  return out;
}

function scanFile(rel, src, cols) {
  const out = [];
  for (const body of sqlLiterals(strip(src))) {
    const map = aliasMap(body);
    const derived = derivedAliases(body);

    // ── alias.column ────────────────────────────────────────────────
    for (const ref of body.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
      const [, alias, col] = ref;
      if (derived.has(alias)) continue;
      const table = map.get(alias);
      if (!table || !cols.has(table)) continue;
      if (!cols.get(table).has(col.toLowerCase())) {
        out.push({ rel, kind: 'alias', ref: `${alias}.${col}`, table, col });
      }
    }

    // ── bare column, single unaliased table ─────────────────────────
    const tables = [...body.matchAll(/\b(?:FROM|JOIN)\s+`?([a-z_][a-z0-9_]*)`?/gi)].map((m) => m[1].toLowerCase());
    const uniq = [...new Set(tables)];
    if (uniq.length !== 1) continue;
    const table = uniq[0];
    if (!cols.has(table)) continue;
    if ([...map.values()].includes(table)) continue;    // aliased: handled above
    if (/\bFROM\s*\(/i.test(body)) continue;            // FROM a subquery
    const sel = body.slice(body.search(/\bSELECT\b/i) + 6, body.search(/\bFROM\b/i));
    if (!sel.trim() || sel.includes('(') || sel.includes('*') || sel.includes('$')) continue;
    for (const part of sel.split(',')) {
      const n = part.replace(/\s+AS\s+[A-Za-z_][\w]*\s*$/i, '').trim().replace(/`/g, '');
      if (!/^[a-z_][a-z0-9_]*$/i.test(n) || SELECT_KEYWORDS.has(n.toLowerCase())) continue;
      if (!cols.get(table).has(n.toLowerCase())) {
        out.push({ rel, kind: 'bare', ref: `${table}.${n}`, table, col: n });
      }
    }
  }
  out.push(...jsFragmentFindings(rel, strip(src), cols));
  return out;
}

async function liveColumns() {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE()');
  const m = new Map();
  for (const r of rows) {
    const t = r.t.toLowerCase();
    if (!m.has(t)) m.set(t, new Set());
    m.get(t).add(r.c.toLowerCase());
  }
  return m;
}

/*
 * Directories the walk below refuses to enter. This list is the one remaining
 * hand-maintained RECORD in this file, so it is kept to two entries, every one
 * of them justified, and checked in reverse (see `unusedSkips`) — an exclusion
 * that excludes nothing is the same rot that produced the bug above.
 *
 *   node_modules  vendor SQL against vendor schemas. Not ours, not fixable by
 *                 us, and ~40k files we would read on every pre-deploy run.
 *   tests         MEASURED, not assumed. A repo-wide run reported exactly six
 *                 findings inside tests/, and all six are fixtures in
 *                 tests/phantom-column-verifier.test.js — the deliberate
 *                 `SELECT user_id, city, user_name FROM tbl_easyfixer` that
 *                 pins the Supply Gap bug, plus `e.nonsense` and friends. A
 *                 test suite's job is to contain broken SQL; a checker that
 *                 red-lights on its own fixtures gets switched off. The cost is
 *                 stated plainly: SQL that only ever runs from a test is not
 *                 checked here.
 *
 * Dot-directories (.git, .github, .githooks, .claude) are skipped by RULE
 * rather than by name — a predicate cannot go stale the way a list does, and
 * none of them holds a .js file in this repo.
 */
const SKIP_DIRS = new Set(['node_modules', 'tests']);

/*
 * THE COLLECTION IS THE CONTRACT, and it used to be a record.
 *
 * This walked `for (const r of ['services', 'routes'])` — a two-entry literal,
 * somebody's note of where our SQL lived the day the script was written. The
 * CONTRACT is every source file in this repo that names a column. The two
 * stopped matching the moment SQL was written outside those two directories,
 * and by 2026-09 thirteen files carrying literal SQL were invisible to it —
 * lib/emp-code.js, lib/scope.js, middleware/basic-auth.js,
 * middleware/idempotency.js, utils/aadhaar-uniqueness.js,
 * utils/pan-uniqueness.js, utils/rate-card-calc.js, validators/job.validator.js
 * and five more under scripts/ and docs/. `npm run verify:phantom-columns`
 * printed a clean bill on files it had never opened, and verify:all with it.
 *
 * That is the failure mode of a record-shaped loop: it can catch a MUTATION of
 * what somebody wrote down and is structurally blind to an ADDITION. So walk
 * the repo and subtract, instead of listing and hoping. A new directory full of
 * SQL is now scanned by default and the only way to hide is to be named above.
 *
 * .mjs and .cjs are included for the same reason and on the same evidence:
 * scripts/check-section-agreement.mjs carries four SQL literals and a .js-only
 * filter walked straight past it.
 */
function sourceFiles() {
  const files = [];
  const skipsUsed = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      /*
       * Matched by NAME, before the isDirectory() test, because a hoisted or
       * bind-mounted node_modules is a SYMLINK — readdir calls that a link, not
       * a directory, and testing isDirectory() first reported the exclusion as
       * stale and failed the gate on a tree where node_modules was plainly
       * there. The name is what the exclusion is about; the inode type is not.
       */
      if (SKIP_DIRS.has(e.name)) { skipsUsed.add(e.name); continue; }
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(full);
    }
  };
  walk(ROOT);
  return { files, unusedSkips: [...SKIP_DIRS].filter((s) => !skipsUsed.has(s)) };
}

async function verifyPhantomColumns() {
  const cols = await liveColumns();
  const findings = [];
  const { files, unusedSkips } = sourceFiles();
  /*
   * sqlFiles is the number the PASS line reports, because it is the contract:
   * files that actually carry a SQL literal, i.e. files this checker owes an
   * answer about. `filesScanned` alone cannot show a shortfall — it went UP
   * when the walk was wrong-but-wider and would go up again if someone dropped
   * a directory of markdown-adjacent .js in. If this number falls while SQL is
   * being written, the walk has lost sight of something.
   */
  let sqlFiles = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (sqlLiterals(strip(src)).length) sqlFiles += 1;
    findings.push(...scanFile(path.relative(ROOT, f), src, cols));
  }
  return { findings, filesScanned: files.length, sqlFiles, unusedSkips };
}

async function cliMain() {
  const { findings, filesScanned, sqlFiles, unusedSkips } = await verifyPhantomColumns();
  console.log(`Scanned ${filesScanned} source files across the repo; ${sqlFiles} carry literal SQL`);

  /*
   * The reverse direction: a name in SKIP_DIRS that matched no directory. Its
   * own message and its own exit, because it is a different fault — not "the
   * SQL is wrong" but "the exclusion list has drifted", which is how this
   * script came to skip most of the codebase in the first place.
   */
  if (unusedSkips.length) {
    console.log(`✗ STALE EXCLUSION(S): SKIP_DIRS names ${unusedSkips.join(', ')} — no such directory in this repo.`);
    console.log('  An exclusion that excludes nothing is a hand-maintained record rotting. Delete the entry or fix the name.');
    process.exitCode = 1;
  }

  if (!findings.length) {
    if (!unusedSkips.length) console.log('✓ No phantom columns — every column our SQL names exists.');
    return;
  }
  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.rel}|${f.ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`✗ ${unique.length} PHANTOM COLUMN REFERENCE(S) — these 500 the moment the query runs:`);
  for (const f of unique) console.log(`  ${f.rel}  ${f.ref}  (${f.kind})`);
  process.exitCode = 1;
}

module.exports = {
  verifyPhantomColumns, scanFile, aliasMap, fileAliasTables,
  jsFragmentFindings, isTernaryBranch, NOT_AN_ALIAS,
};

if (require.main === module) {
  cliMain().catch((e) => { console.error('FAIL', e.message); process.exit(2); }).finally(() => pool.end());
}
