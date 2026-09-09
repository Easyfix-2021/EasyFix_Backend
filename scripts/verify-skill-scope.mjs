#!/usr/bin/env node
/*
 * verify-skill-scope — does a directory-scoped skill describe THIS repository?
 *
 * WHY THIS EXISTS. A skill under `.claude/skills/` is scoped by its PATH, and the
 * harness tells every future session to prefer it over the general skill of the
 * same name when working in this directory. That authority is granted by where
 * the file sits, which is set by whoever copied it — nothing checks whether its
 * CONTENT is about this codebase.
 *
 * On 2026-09-08 all FIVE skills here turned out to be copies from a sibling HRMS
 * project: wrong tables, wrong paths, a security checklist asserting an auth
 * model this product explicitly does not use, and whole sections about a
 * frontend this repo does not have. They had been preferred over the general
 * skills the entire time.
 *
 * The failure is systematically produced by ordinary work — copying is the
 * cheapest way to make a scoped skill — so a prose warning is not enough. This
 * is the mechanical version: every path and npm script a skill names must
 * resolve, and no foreign token may appear.
 *
 *   node scripts/verify-skill-scope.mjs              # check all skills
 *   node scripts/verify-skill-scope.mjs <file>       # check one
 *   node scripts/verify-skill-scope.mjs --self-test  # fixture control
 *
 * Exits 1 on an unresolved claim. Deliberately CONSERVATIVE: it only asserts
 * things it can resolve unambiguously, because a checker that cries wolf on
 * prose gets disabled and then protects nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, '.claude', 'skills');

/*
 * Tokens that name the sibling project this directory was copied from. A hit is
 * conclusive — these identifiers do not exist here in any form — so unlike the
 * path check below there is no judgement involved.
 */
const FOREIGN = [
  /\bcp_hr_[a-z_]+/g, /\bcp_cm_[a-z_]+/g, /\bshift_attendance\b/g, /\bemp_code\b/g,
  /\bHRMS\b/g, /\bserver\/db\.js/g, /\bserver\/migrations/g, /\bserver\/api\//g,
  /\bNEXT_PUBLIC_/g, /\bNext\.js/g, /\bTailwind(CSS)?\b/g, /\bReact\.memo\b/g,
  /1Office Suite/g, /channelplay_properties/g,
];

/*
 * A backtick span is a PATH claim only when it contains a SLASH.
 *
 * A bare filename is deliberately NOT one. Skills legitimately write
 * "gates in `middleware/`: `role.js`, `require-action.js`" — the directory is
 * supplied by the sentence, and resolving those names against the repo root
 * flags correct prose. That was this checker's own first false-positive class.
 *
 * A slash alone is not enough either — it over-matches require specifiers
 * (`../../db`), package names (`mysql2/promise`), git refs
 * (`origin/Production`), timezones (`Asia/Kolkata`) and prose slashes
 * (`beginTransaction/commit/rollback`). So the FIRST SEGMENT must also be a real
 * top-level entry of this repo, read from disk rather than hardcoded — that list
 * maintains itself as the tree changes.
 *
 * This loses no real detection. `server/` IS a top-level entry here (it holds
 * scheduler.js), so `server/db.js` still resolves as a claim and still fails —
 * which is the exact defect that motivated the tool. Positive-controlled against
 * the pre-audit versions in git: all five are still flagged.
 */
const PATH_RE = /`([A-Za-z0-9_.*-]+\/[A-Za-z0-9_./*-]*(?:\.(?:js|mjs|cjs|json|sql|md|yml|yaml))?)`/g;
const SCRIPT_RE = /`?npm run ([a-z][a-z0-9:-]*)`?/g;

/** A path claim containing a glob or an angle-bracket placeholder is unresolvable by design. */
const isTemplate = (p) => /[*<>]/.test(p);

/** Top-level entries of the tree being checked — the set a real repo path must start with. */
function topLevel(root) {
  try { return new Set(fs.readdirSync(root).filter((n) => !n.startsWith('.'))); } catch { return new Set(); }
}
const looksLikeRepoPath = (claim, tops) => tops.has(claim.split('/')[0]);

function readScripts() {
  try {
    return new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {}));
  } catch { return new Set(); }
}

function checkFile(file, opts = {}) {
  const root = opts.root || ROOT;
  const scripts = opts.scripts || readScripts();
  const src = fs.readFileSync(file, 'utf8');
  const problems = [];
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  for (const re of FOREIGN) {
    re.lastIndex = 0; // /g regexes carry lastIndex between files — reset or every other file reads clean
    let m;
    while ((m = re.exec(src))) {
      problems.push({ line: lineOf(m.index), kind: 'foreign', text: m[0] });
    }
  }

  PATH_RE.lastIndex = 0;
  let m;
  const seen = new Set();
  const tops = topLevel(root);
  while ((m = PATH_RE.exec(src))) {
    const claim = m[1];
    if (isTemplate(claim) || seen.has(claim) || !looksLikeRepoPath(claim, tops)) continue;
    seen.add(claim);
    if (!fs.existsSync(path.join(root, claim))) {
      problems.push({ line: lineOf(m.index), kind: 'missing-path', text: claim });
    }
  }

  SCRIPT_RE.lastIndex = 0;
  const seenS = new Set();
  while ((m = SCRIPT_RE.exec(src))) {
    if (seenS.has(m[1])) continue;
    seenS.add(m[1]);
    if (!scripts.has(m[1])) problems.push({ line: lineOf(m.index), kind: 'missing-script', text: `npm run ${m[1]}` });
  }

  // An un-audited skill is not a failure, but it must be visible.
  const origin = /⚠ ORIGIN/.test(src);
  return { file, problems, origin };
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skill-scope-'));
  const w = (n, s) => { const f = path.join(dir, n); fs.writeFileSync(f, s); return f; };
  fs.writeFileSync(path.join(dir, 'real.js'), '');
  const scripts = new Set(['lint']);
  const cases = [
    ['clean',        '`real.js` and `npm run lint`',                    0],
    ['foreign-table','see `cp_hr_employee_leave_application`',          1],
    ['foreign-path', 'pool from `server/db.js`',                        1],
    ['foreign-name', 'conventions for HRMS',                            1],
    // DELIBERATELY NOT FLAGGED: `does` is not a top-level entry, so this is not
    // read as a repo-path claim. That is the accepted trade-off — the tool would
    // rather miss an exotic claim than flag prose, because a checker that cries
    // wolf gets disabled. The `real-dir-bad-file` case below is the positive one.
    ['unrooted-path','edit `does/not/exist.js`',                       0],
    ['missing-script','run `npm run nope:missing`',                     1],
    // Must NOT flag: prose in backticks, and template/glob paths.
    ['prose-ok',     'use `?` placeholders and `Promise.all()`',        0],
    ['glob-ok',      'check `routes/**/*.js` and `routes/<group>/x.js`',0],
    // Slash-containing spans that are NOT repo paths. Each of these was a live
    // false positive before the first-segment rule; they are fixtures now so the
    // rule cannot be quietly relaxed back.
    ['require-spec', 'require `../../db` not `../db`',                  0],
    ['pkg-spec',     'uses `mysql2/promise`',                           0],
    ['git-ref',      'diff against `origin/Production`',                0],
    ['timezone',     'cron runs in `Asia/Kolkata`',                     0],
    ['prose-slash',  'wrap in `beginTransaction/commit/rollback`',      0],
    // …but a claim whose first segment IS a real top-level entry must still fail.
    ['real-dir-bad-file', 'pool at `sub/nope.js`',                      1],
  ];
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  let fails = 0;
  console.log('FIXTURE           WANT  GOT  VERDICT');
  for (const [name, body, want] of cases) {
    const r = checkFile(w(`${name}.md`, body), { root: dir, scripts });
    const got = r.problems.length ? 1 : 0;
    const ok = got === want;
    if (!ok) fails += 1;
    console.log(`${name.padEnd(17)} ${String(want).padEnd(5)} ${String(got).padEnd(4)} ${ok ? 'PASS' : 'FAIL — ' + JSON.stringify(r.problems)}`);
  }
  // Discovery control: the real skill dir must be non-empty, or a clean run means nothing.
  const n = fs.existsSync(SKILL_DIR) ? fs.readdirSync(SKILL_DIR).length : 0;
  const disc = n > 0;
  if (!disc) fails += 1;
  console.log(`discovery: ${n} skill dir(s) found  ${disc ? 'PASS' : 'FAIL — a clean sweep over zero files is not a clean sweep'}`);
  console.log(fails === 0 ? '\nALL FIXTURES PASS' : `\n${fails} FIXTURE(S) FAILED`);
  return fails === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) process.exit(selfTest());

const target = argv.find((a) => !a.startsWith('--'));
const files = target
  ? [path.resolve(target)]
  : (fs.existsSync(SKILL_DIR) ? fs.readdirSync(SKILL_DIR)
      .map((d) => path.join(SKILL_DIR, d, 'SKILL.md')).filter((f) => fs.existsSync(f)) : []);

if (files.length === 0) {
  console.error('no SKILL.md found — nothing was checked, which is not the same as clean');
  process.exit(1);
}

let bad = 0;
for (const f of files) {
  const r = checkFile(f);
  const rel = path.relative(ROOT, f);
  if (r.problems.length === 0) {
    console.log(`✓ ${rel}${r.origin ? '   (un-audited: carries an ORIGIN note)' : ''}`);
  } else {
    bad += 1;
    console.log(`✗ ${rel}`);
    for (const p of r.problems) console.log(`    ${p.kind.padEnd(14)} line ${p.line}: ${p.text}`);
  }
}
console.log(bad === 0 ? `\n${files.length} skill(s) describe this repository.` : `\n${bad} skill(s) name things that are not here.`);
process.exit(bad === 0 ? 0 : 1);
