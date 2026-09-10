#!/usr/bin/env node
/*
 * Sweep for named CommonJS exports nobody consumes.
 *
 * POPULATION comes from the AST, not a regex: every `module.exports = {...}`,
 * `module.exports.x =` and `exports.x =` in the tracked .js files of a repo.
 * A regex over "module.exports" would miss the shorthand/renamed properties and
 * would invent names out of prose.
 *
 * CLASSIFICATION is three-way, because "unused" hides three different findings:
 *   DEAD          the identifier appears nowhere else in the repo, not even in
 *                 its own file below the definition — nothing reads it at all.
 *   INTERNAL-ONLY used inside its own file, exported for nobody. Not dead code;
 *                 an over-wide interface.
 *   TEST-ONLY     referenced only under tests/. Either a seam kept on purpose or
 *                 production code that lost its caller — a human call.
 *
 * THE ERROR IS DELIBERATELY BIASED toward FALSE NEGATIVES. Usage is a
 * word-boundary identifier match, so a short or generic name (`get`, `list`,
 * `parse`) collides with unrelated code and reads as CONSUMED. That direction is
 * the safe one for a sweep whose output might become deletions: it under-reports
 * dead exports rather than proposing to delete a live one.
 *
 * Usage: node scripts/dead-exports.js . [--ref origin/HotFix] [--quiet]
 *        npm run sweep:exports
 *
 * The two PURE halves — exportedNames() and internalUses() — are exported and
 * pinned in tests/dead-exports.test.js. They are the only parts that can
 * regress silently: get them wrong and the sweep reports a confident, wrong
 * list. The git/DB-free split mirrors scripts/migration-status.js, whose own
 * tests cover artifactsOf for the same reason.
 *
 * FOUND ON ITS FIRST RUN (2026-09-10): 31 dead exports across the backend, of
 * which 23 were deleted and 8 kept deliberately — several turned out to be
 * unenforced invariants (an OTP attempt cap nothing reads, a scheduler cancel
 * flag no job polls), where the unused export is the only evidence the
 * contract is half-built. Read a finding before deleting it.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/* ABSOLUTE, always — a relative root would resolve node_modules against THIS
 * file's directory rather than the cwd. Masked here by the require('acorn')
 * fallback below, which is exactly why it is worth pinning. */
const ROOT = path.resolve(process.argv[2] || '.');
const refIdx = process.argv.indexOf('--ref');
const REF = refIdx > -1 ? process.argv[refIdx + 1] : null;

let acorn;
try { acorn = require(path.join(ROOT || '.', 'node_modules', 'acorn')); }
catch { acorn = require('acorn'); }

/* ── 1. exported names, per file, from the AST ─────────────────────────── */
function exportedNames(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  } catch { return null; }            // unparseable → reported, never silently 0
  const names = [];
  const exportRanges = [];
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
      const L = n.left;
      const isModExports = L.object.type === 'Identifier' && L.object.name === 'module'
        && L.property.type === 'Identifier' && L.property.name === 'exports';
      const isExportsDot = L.object.type === 'Identifier' && L.object.name === 'exports'
        && L.property.type === 'Identifier';
      // module.exports = { a, b: c }
      if (isModExports && n.right.type === 'ObjectExpression') {
        exportRanges.push([n.right.start, n.right.end]);
        for (const p of n.right.properties) {
          if (p.type === 'Property' && p.key && (p.key.name || p.key.value)) {
            names.push(String(p.key.name || p.key.value));
          }
        }
      }
      // module.exports.foo = …   /   exports.foo = …
      if (L.object.type === 'MemberExpression'
        && L.object.object.type === 'Identifier' && L.object.object.name === 'module'
        && L.object.property.name === 'exports' && L.property.type === 'Identifier') {
        names.push(L.property.name);
      } else if (isExportsDot) {
        names.push(L.property.name);
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);
  return { names: [...new Set(names)], ast, exportRanges };
}

/*
 * How many times the file REALLY uses the name, as opposed to declaring and
 * exporting it.
 *
 * Counting raw occurrences does not work and the control proved it: for
 *   const STAGE_LABELS = Object.freeze({...});
 *   module.exports = { …, STAGE_LABELS };
 * a text count is already 2 with zero actual uses, so every dead export was
 * being mis-binned as "used internally". Excluded here: the declaration's own
 * id (const/let/function/class), non-computed property KEYS, and every
 * identifier inside a module.exports object literal.
 */
function internalUses(ast, exportRanges, name) {
  let n = 0;
  const inExport = (node) => exportRanges.some(([a, b]) => node.start >= a && node.end <= b);
  const walk = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && node.name === name && !inExport(node)) {
      const isDeclId = parent
        && ((parent.type === 'VariableDeclarator' && parent.id === node)
          || ((parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration') && parent.id === node));
      const isPropKey = parent && parent.type === 'Property' && parent.key === node && !parent.computed
        && parent.value !== node;
      const isMemberProp = parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed;
      if (!isDeclId && !isPropKey && !isMemberProp) n += 1;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, node));
      else if (v && typeof v.type === 'string') walk(v, node);
    }
  };
  walk(ast, null);
  return n;
}

/* ── CLI ONLY BELOW ─────────────────────────────────────────────────────
 * require()ing this file must not walk a repo or shell out to git — the tests
 * import the pure halves above and nothing else, and a module that shelled out
 * at import time could not be tested at all. */
module.exports = { exportedNames, internalUses };
if (require.main === module) main();

function main() {
  const git = (args) => execSync(`git -C "${ROOT}" ${args}`, { maxBuffer: 1 << 28 }).toString();

  /* Tracked .js at the chosen ref — never a filesystem walk, which would sweep
   * node_modules, build output and a peer's untracked scratch files. */
  const tracked = git(REF ? `ls-tree -r ${REF} --name-only` : 'ls-files')
    .split('\n').filter((f) => f.endsWith('.js'));

  const read = (f) => (REF ? git(`show ${REF}:${f}`) : fs.readFileSync(path.join(ROOT, f), 'utf8'));

  const SRC = tracked.filter((f) => !f.startsWith('tests/'));
  const TESTS = tracked.filter((f) => f.startsWith('tests/'));

/* ── 2. index the corpus once ──────────────────────────────────────────── */
const bodies = new Map();
for (const f of [...SRC, ...TESTS]) {
  try { bodies.set(f, read(f)); } catch { /* deleted at this ref */ }
}

const wordRe = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

/* ── 3. classify ───────────────────────────────────────────────────────── */
const results = [];
let parsedFiles = 0;
let unparseable = [];
let totalExports = 0;

for (const f of SRC) {
  const code = bodies.get(f);
  if (code === undefined) continue;
  const parsed = exportedNames(code);
  if (parsed === null) { unparseable.push(f); continue; }
  const { names, ast, exportRanges } = parsed;
  parsedFiles += 1;
  totalExports += names.length;

  // Strip the definition file's own export block so "exported here" is not
  // mistaken for "used here".
  for (const name of names) {
    const re = wordRe(name);
    let srcRefs = 0; let testRefs = 0; const where = [];
    for (const [g, body] of bodies) {
      if (g === f) continue;
      if (re.test(body)) {
        if (g.startsWith('tests/')) testRefs += 1;
        else { srcRefs += 1; if (where.length < 3) where.push(g); }
      }
    }
    const own = internalUses(ast, exportRanges, name);
    let status;
    if (srcRefs > 0) status = 'live';
    else if (testRefs > 0) status = 'test-only';
    else if (own > 0) status = 'internal-only';
    else status = 'dead';
    results.push({ file: f, name, status, srcRefs, testRefs, own, where });
  }
}

/* ── 4. report, denominator first ──────────────────────────────────────── */
const by = (s) => results.filter((r) => r.status === s);
console.log(`\nrepo: ${ROOT}${REF ? ` @ ${REF}` : ''}`);
console.log(`  source files parsed : ${parsedFiles} of ${SRC.length}   (test files indexed: ${TESTS.length})`);
if (unparseable.length) console.log(`  UNPARSEABLE         : ${unparseable.length}  ${unparseable.slice(0, 5).join(', ')}`);
console.log(`  named exports found : ${totalExports}`);
console.log(`     live             : ${by('live').length}`);
console.log(`     test-only        : ${by('test-only').length}`);
console.log(`     internal-only    : ${by('internal-only').length}`);
console.log(`     DEAD             : ${by('dead').length}`);
const flagged = totalExports ? ((by('dead').length + by('internal-only').length) / totalExports * 100).toFixed(1) : '0';
console.log(`  flagged (dead+internal): ${flagged}%  ← >20% means the matcher needs redesign, not an allowlist`);

for (const s of ['dead', 'internal-only', 'test-only']) {
  if (process.argv.includes('--quiet') && s === 'test-only') continue;
  console.log(`\n── ${s.toUpperCase()} ──`);
  for (const r of by(s).sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`  ${r.file}  ::  ${r.name}${s === 'test-only' ? `   (${r.testRefs} test file(s))` : ''}`);
  }
}

}
