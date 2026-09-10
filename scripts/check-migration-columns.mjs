#!/usr/bin/env node
/*
 * check-migration-columns — would this migration's INSERTs actually run?
 *
 * WHY THIS EXISTS. migrations/2026-09-04-seed-client-request-reasons.sql failed
 * on its first run with "Field 'is_new' doesn't have a default value". The file
 * had CARRIED A COMMENT WARNING ABOUT EXACTLY THAT, inherited from the seed it
 * was modelled on — "if this DB's action_taken_reason has any additional NOT
 * NULL column without a default (e.g. is_new / created_on), add it to each
 * INSERT" — and it still shipped, because a warning in prose is not a check.
 *
 * The failure is invisible until the moment the migration runs, which on
 * Production is the worst possible time to discover it.
 *
 * WHAT IT CHECKS. For every INSERT in a migration, every column on the target
 * table that is NOT NULL, has no DEFAULT, and is not AUTO_INCREMENT must be
 * named in the INSERT's column list. That is precisely the set MySQL will
 * reject, and it is knowable only from the SCHEMA — no amount of reading the
 * SQL text can tell you whether `is_new` has a default.
 *
 * So this needs a live connection, which makes it a pre-deploy check rather
 * than a CI gate. It runs against whatever DB_* the environment points at; run
 * it against the database you are about to migrate, not a different one — a
 * column can be nullable on QA and NOT NULL on Production.
 *
 *   npm run check:migrations              # every file in migrations/
 *   node scripts/check-migration-columns.mjs migrations/foo.sql
 *
 * Exit 1 on any INSERT that would fail. Exit 2 if the DB is unreachable —
 * DELIBERATELY not 0: "I could not check" must never read as "it is fine",
 * which is the whole class of bug this repo keeps finding.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = path.join(ROOT, 'migrations');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = args.length
  ? args.map((a) => path.resolve(a))
  : fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(DIR, f));

if (!files.length) {
  console.log('no migrations to check');
  process.exit(0);
}

/*
 * Parse `INSERT INTO tbl (a, b, c)`. Backticks optional, whitespace and
 * newlines free-form. An INSERT without a column list is reported separately:
 * it is legal SQL but positional, so it breaks the moment a column is added,
 * and this check cannot verify it either.
 */
const INSERT = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?([A-Za-z0-9_]+)`?\s*(\(([^)]*)\))?/gi;

/*
 * Blank out comments and string literals before scanning for INSERTs.
 *
 * WHY: this checker read PROSE as SQL. migrations/2026-09-10-job-offer-closed-
 * reason.sql documents, in a `--` comment, that the legacy Java CRM contains no
 * "INSERT INTO tbl_job_offer" — and the scanner reported that sentence as a
 * positional INSERT on line 33 that does not exist. A migration cannot explain
 * a write without tripping the check that looks for writes, which pushes
 * authors toward writing LESS documentation to keep a checker quiet. String
 * literals go too: a seeded value containing the words is data, not a
 * statement.
 *
 * REPLACED WITH SPACES, NOT DELETED, and newlines are preserved: `at:` below
 * derives the line number from the match offset in this same string, so
 * shortening it would misreport every line number after the first comment.
 *
 * Hand-rolled rather than regex'd because the cases interact: `--` inside a
 * string is not a comment, a quote inside a comment does not open a string,
 * and MySQL needs whitespace after `--` (so `a--b` is arithmetic, not a
 * comment) while `#` comments to end-of-line unconditionally.
 */
function blankNonCode(sql) {
  const out = sql.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    // ── line comment: `-- ` (MySQL requires the following whitespace) or `#`
    if ((c === '-' && next === '-' && (i + 2 >= sql.length || /\s/.test(sql[i + 2]))) || c === '#') {
      while (i < sql.length && sql[i] !== '\n') { blank(i); i += 1; }
      continue;
    }
    // ── block comment
    if (c === '/' && next === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { blank(i); i += 1; }
      if (i < sql.length) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    /*
     * ── BACKTICKS ARE IDENTIFIERS, NOT VALUES: skip past them WITHOUT
     * blanking. Blanking them broke `INSERT INTO \`t\` (\`a\`)` — the table
     * name vanished and the statement stopped being found at all, which the
     * self-test caught on its first run. Identifier text is part of the
     * statement's structure; only string VALUES are data.
     */
    if (c === '`') {
      i += 1;
      while (i < sql.length && sql[i] !== '`') i += 1;
      i += 1;
      continue;
    }
    // ── string literal: skip its CONTENTS, keep the delimiters so the
    //    surrounding statement structure is untouched.
    if (c === "'" || c === '"') {
      const q = c;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }  // escaped char
        if (sql[i] === q) {
          if (sql[i + 1] === q) { blank(i); blank(i + 1); i += 2; continue; } // '' doubled quote
          i += 1; break;                                                      // closing delimiter
        }
        blank(i); i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function insertsIn(rawSql) {
  const sql = blankNonCode(rawSql);
  const out = [];
  for (const m of sql.matchAll(INSERT)) {
    out.push({
      table: m[1],
      cols: m[3] ? m[3].split(',').map((c) => c.trim().replace(/`/g, '').toLowerCase()).filter(Boolean) : null,
      at: sql.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/*
 * --self-test: drive insertsIn() over hand-written fixtures with known answers,
 * BEFORE any database is touched. Same pattern (and same reason) as
 * scripts/verify-skill-scope.mjs and scan-unguarded-await.js: the census below
 * exits 0 when it finds nothing, which is indistinguishable from a scanner that
 * can no longer see anything. These fixtures make the tool prove it can still
 * fail.
 *
 * Added 2026-09-10, when the scanner read a `--` comment describing a legacy
 * INSERT as a real one.
 */
function selfTest() {
  const CASES = [
    ['bare INSERT with columns is found',
      'INSERT INTO t (a, b) VALUES (1, 2);',
      [{ table: 't', cols: ['a', 'b'], at: 1 }]],

    ['column-list-less INSERT is still reported (cols: null)',
      'INSERT INTO t VALUES (1, 2);',
      [{ table: 't', cols: null, at: 1 }]],

    ['a `--` comment mentioning an INSERT is NOT one',
      '-- there is no INSERT INTO tbl_job_offer anywhere\nSELECT 1;',
      []],

    ['a `#` comment mentioning an INSERT is NOT one',
      '# INSERT INTO t VALUES (1)\nSELECT 1;',
      []],

    ['a block comment mentioning an INSERT is NOT one',
      '/* INSERT INTO t VALUES (1) */\nSELECT 1;',
      []],

    ['a string literal mentioning an INSERT is NOT one',
      "INSERT INTO t (a) VALUES ('INSERT INTO other VALUES (1)');",
      [{ table: 't', cols: ['a'], at: 1 }]],

    ['`--` inside a string is not a comment, so the statement still parses',
      "INSERT INTO t (a) VALUES ('a -- b');",
      [{ table: 't', cols: ['a'], at: 1 }]],

    ['a doubled quote inside a string does not end it early',
      "INSERT INTO t (a) VALUES ('it''s INSERT INTO x VALUES (1)');",
      [{ table: 't', cols: ['a'], at: 1 }]],

    ['LINE NUMBERS survive blanking — the real INSERT is on line 4',
      '-- comment\n-- comment\n\nINSERT INTO t (a) VALUES (1);',
      [{ table: 't', cols: ['a'], at: 4 }]],

    ['a comment BEFORE a real insert does not hide it',
      '-- INSERT INTO decoy VALUES (1)\nINSERT INTO t (a) VALUES (1);',
      [{ table: 't', cols: ['a'], at: 2 }]],

    ['backticked table and columns still parse',
      'INSERT INTO `t` (`a`, `b`) VALUES (1, 2);',
      [{ table: 't', cols: ['a', 'b'], at: 1 }]],
  ];

  let failed = 0;
  for (const [name, sql, want] of CASES) {
    const got = insertsIn(sql);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) {
      failed += 1;
      console.error(`  \u2717 ${name}`);
      console.error(`      want ${JSON.stringify(want)}`);
      console.error(`      got  ${JSON.stringify(got)}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} of ${CASES.length} self-test case(s) FAILED`);
    return 1;
  }
  console.log(`check-migration-columns self-test: ${CASES.length}/${CASES.length} cases pass`);
  return 0;
}

if (process.argv.slice(2).includes('--self-test')) process.exit(selfTest());

const { default: mysql } = await import('mysql2/promise');
let conn;
try {
  conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 10000,
  });
} catch (e) {
  console.error(`cannot reach the database, so nothing was checked: ${e.message}`);
  console.error('exiting 2 — an unchecked migration must not look like a clean one.');
  process.exit(2);
}

const cache = new Map();
async function requiredColumns(table) {
  if (cache.has(table)) return cache.get(table);
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [process.env.DB_NAME, table],
  );
  if (!rows.length) { cache.set(table, null); return null; }   // table not here
  const need = rows
    .filter((r) => r.IS_NULLABLE === 'NO'
      && r.COLUMN_DEFAULT === null
      && !/auto_increment/i.test(r.EXTRA || '')
      // A generated column is computed, never supplied.
      && !/GENERATED/i.test(r.EXTRA || ''))
    .map((r) => String(r.COLUMN_NAME).toLowerCase());
  cache.set(table, need);
  return need;
}

let problems = 0;
let checked = 0;
for (const file of files) {
  const sql = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  for (const ins of insertsIn(sql)) {
    const need = await requiredColumns(ins.table);
    if (need === null) {
      console.log(`  ?  ${rel}:${ins.at} — table \`${ins.table}\` is not in ${process.env.DB_NAME}; skipped`);
      continue;
    }
    if (!ins.cols) {
      console.log(`  !  ${rel}:${ins.at} — INSERT INTO \`${ins.table}\` has no column list, so it is positional and cannot be checked`);
      problems += 1;
      continue;
    }
    checked += 1;
    const missing = need.filter((c) => !ins.cols.includes(c));
    if (missing.length) {
      problems += 1;
      console.error(`  ✗  ${rel}:${ins.at} — INSERT INTO \`${ins.table}\` omits NOT NULL column(s) with no default: ${missing.join(', ')}`);
      console.error(`     MySQL will reject this statement: "Field '${missing[0]}' doesn't have a default value"`);
    }
  }
}

await conn.end();
console.log(`\n${checked} INSERT(s) checked against ${process.env.DB_NAME}. ${problems ? `${problems} problem(s).` : 'All supply every required column.'}`);
process.exit(problems ? 1 : 0);
