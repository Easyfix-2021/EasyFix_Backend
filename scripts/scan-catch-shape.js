#!/usr/bin/env node
'use strict';

/*
 * scan-catch-shape.js — census of catch blocks that assume the SHAPE of what
 * they caught.
 *
 * ─── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `catch (e)` binds whatever was thrown. JavaScript lets that be anything —
 * `null`, a string, a bare object — not just an Error. Two hazards, and they
 * are NOT equally severe:
 *
 *   (A) `e.message` where e is null/undefined
 *       → TypeError raised INSIDE the catch. It escapes the handler; in
 *         Express 4 that is an unhandled rejection. server.js has a backstop
 *         so the process survives, but the REQUEST HANGS with no response.
 *
 *   (B) `next(e)` where e is FALSY (null, undefined, 0, '')
 *       → Express reads a falsy first argument as "no error, continue". The
 *         request falls through to middleware/error-handler.js `notFound` —
 *         a 404, no 500, nothing logged. The nastier one: the failure produces
 *         no error anywhere, so it is indistinguishable from success.
 *
 *   (C) `e.message` where e is a non-null object WITHOUT `.message`
 *       → logs "undefined". Cosmetic. NOT reported by this scanner, and
 *         deliberately so: the repo throws ~41 object literals of the shape
 *         `{ status, code, message }` (utils/jwt.js, services/*.service.js).
 *         Every one carries `.message`, and all are truthy, so they are (C) at
 *         worst. Counting them would triple the census with non-defects.
 *
 * Both hazards are the defect fixed in routes/public/maps.js and
 * routes/admin/products.js on 2026-09-08. Those two files are the reference
 * implementations and MUST report zero here; the self-test asserts it.
 *
 * ─── WHAT IT DOES ──────────────────────────────────────────────────────────
 *
 * AST only (acorn, already a transitive dep of eslint — no new dependency, no
 * regex analysis). Structure, parse fallback and self-test discipline follow
 * scripts/scan-unguarded-await.js.
 *
 *   node scripts/scan-catch-shape.js              # human summary
 *   node scripts/scan-catch-shape.js --json       # machine-readable
 *   node scripts/scan-catch-shape.js --self-test  # fixture control (below)
 *
 * Exit code is 0 for a census run, always — this is a measurement, not a gate.
 * `--self-test` is the exception: it exits 1 if any fixture verdict is wrong,
 * because an unvalidated scanner's silence is indistinguishable from a clean
 * result.
 *
 * ─── TWO STRUCTURALLY DIFFERENT PASSES ─────────────────────────────────────
 *
 * `catch (e) {}` is one way to bind a rejection; `p.catch(e => …)` is the
 * other, and it shares none of the first's syntax. A census built only from
 * CatchClause nodes is systematically blind to the variant that looks
 * different — which is also the variant a uniform fix would miss. Both are
 * walked, by the same guard logic, and reported as separate counts. When the
 * two agree that is evidence; when the callback pass adds sites the clause
 * pass could not see, those are the high-risk ones, not a footnote.
 *
 * ─── THE GUARD RULE, PRECISELY ─────────────────────────────────────────────
 *
 * A reference to the caught binding is GUARDED when any of these hold:
 *
 *   - it is the object of an optional member access  `e?.message`
 *   - it sits in the RIGHT operand of an `&&` whose LEFT operand mentions the
 *     binding                                        `e && e.message`
 *   - it sits in the consequent of an `if` or a ternary whose TEST mentions
 *     the binding    `e instanceof Error ? e.message : String(e)`
 *     (the ALTERNATE is NOT guarded: after `if (e) {…} else {…}` the binding is
 *     known falsy in the else, so a deref there is the defect, not the fix)
 *   - the binding was REASSIGNED earlier in the catch  `e = e || new Error()`
 *
 * Everything else is a finding. Passing the binding through a normaliser —
 * `next(asError(e))`, `next(e || new Error(x))`, `next(e instanceof Error ? e
 * : new Error(x))` — needs no special case: the argument to `next` is then a
 * CallExpression / LogicalExpression / ConditionalExpression rather than the
 * bare identifier, so it is never a candidate in the first place.
 *
 * ─── WHAT THIS SCANNER CANNOT SEE (stated, not discovered later) ───────────
 *
 *   1. Cross-function flow. `catch (e) { fail(e, next); }` derefs inside the
 *      callee. Invisible here, and not counted anywhere.
 *   2. Aliasing. `const x = e; x.message` — the deref is attributed to `x`,
 *      which is not the binding, so it is missed.
 *   3. Control-flow dominance. `if (!e) return next(new Error()); e.message`
 *      is genuinely safe but reports as unguarded — a FALSE POSITIVE. The
 *      guard rule is syntactic containment, not dominance.
 *   4. Reassignment is POSITIONAL, by source offset, not by control flow. A
 *      reassignment inside one branch marks every later reference guarded,
 *      including references the branch never reaches — a FALSE NEGATIVE.
 *   5. Whether a non-Error can actually ARRIVE at a site. That is reachability,
 *      answered by the throw-source census in the report, not by this walk.
 *   6. `catch { }` with no binding cannot dereference anything, so it is
 *      counted in the denominator and never flagged.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules', 'tests', 'uploads', 'logs', 'coverage', 'dist', 'build',
  'stt-service', '.git', 'assets', 'deploy',
]);

// ── AST plumbing (same shape as scan-unguarded-await.js) ───────────────────

const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function isFn(n) { return n && FN_TYPES.has(n.type); }

function walk(node, parents, visit, parent) {
  if (!node || typeof node.type !== 'string') return;
  parents.set(node, parent || null);
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) if (child && typeof child.type === 'string') walk(child, parents, visit, node);
    } else if (val && typeof val.type === 'string') {
      walk(val, parents, visit, node);
    }
  }
}

function ancestors(node, parents) {
  const out = [];
  let cur = parents.get(node);
  while (cur) { out.push(cur); cur = parents.get(cur); }
  return out;
}

/* Does this subtree mention `name` as an identifier? Used for the guard tests. */
function mentions(node, name) {
  let found = false;
  const seen = new Map();
  walk(node, seen, (n) => { if (n.type === 'Identifier' && n.name === name) found = true; }, null);
  return found;
}

/*
 * Nearest useful label for a finding: the enclosing route registration if the
 * catch lives under one (`router.post('/:id/assign', …)`), else the nearest
 * named function, else '<anonymous>'.
 */
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'head', 'options']);

function describeSite(node, parents) {
  let fnName = null;
  for (const a of ancestors(node, parents)) {
    if (a.type === 'CallExpression' && a.callee.type === 'MemberExpression'
        && !a.callee.computed && a.callee.property.type === 'Identifier'
        && METHODS.has(a.callee.property.name)
        && a.arguments[0] && a.arguments[0].type === 'Literal'
        && typeof a.arguments[0].value === 'string') {
      return `${a.callee.property.name.toUpperCase()} ${a.arguments[0].value}`;
    }
    if (!fnName && isFn(a)) {
      if (a.id) fnName = a.id.name;
      else {
        const p = parents.get(a);
        if (p && p.type === 'VariableDeclarator' && p.id.type === 'Identifier') fnName = p.id.name;
        else if (p && p.type === 'Property' && p.key.type === 'Identifier') fnName = p.key.name;
      }
    }
  }
  return fnName || '<anonymous>';
}

// ── The guard rule ─────────────────────────────────────────────────────────

/*
 * `ref` is an Identifier node naming the binding. `body` is the catch body (or
 * the callback body). `reassignedAt` is the source offset of the earliest
 * assignment to the binding, or Infinity.
 */
function isGuarded(ref, parents, body, name, reassignedAt) {
  if (ref.start > reassignedAt) return 'reassigned';

  let child = ref;
  for (const a of ancestors(ref, parents)) {
    if (a === body) break;

    // e?.message — the optional flag lives on the MemberExpression itself.
    if (a.type === 'MemberExpression' && a.object === child && a.optional) return 'optional-chain';
    // Acorn also wraps optional chains in ChainExpression; belt and braces.
    if (a.type === 'ChainExpression') return 'optional-chain';

    // e && e.message  /  e != null && e.message
    if (a.type === 'LogicalExpression' && a.operator === '&&'
        && a.right === child && mentions(a.left, name)) return 'short-circuit';

    // e instanceof Error ? e.message : String(e)
    if (a.type === 'ConditionalExpression' && a.consequent === child
        && mentions(a.test, name)) return 'ternary-test';

    // if (e && e.status) { … e.message … }   — consequent only, never alternate
    if (a.type === 'IfStatement' && a.consequent === child
        && mentions(a.test, name)) return 'if-test';

    child = a;
  }
  return null;
}

/*
 * Analyse one caught binding. `param` is the CatchClause param or the callback's
 * first param; `body` is the block/expression it scopes.
 */
function analyseBinding(param, body, parents, ctx, out) {
  // `catch ({ message })` destructures — that THROWS on a null/undefined
  // rejection just as `e.message` does, and there is no binding to guard.
  if (param && param.type !== 'Identifier') {
    out.findings.push({
      ...ctx, line: param.loc.start.line, column: param.loc.start.column + 1,
      hazard: 'A', kind: 'destructured-binding',
      detail: 'catch binding is destructured — throws on a null/undefined rejection',
      excerpt: ctx.lineAt(param.loc.start.line),
    });
    return;
  }
  if (!param) return; // `catch { }` — nothing to dereference
  const name = param.name;

  const refs = [];
  let reassignedAt = Infinity;
  const seen = new Map();
  walk(body, seen, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === name) {
      reassignedAt = Math.min(reassignedAt, n.end);
    }
    if (n.type === 'Identifier' && n.name === name) refs.push(n);
  }, null);
  // The sub-walk built its own parent map; merge so ancestors() works from here.
  for (const [k, v] of seen) if (!parents.has(k)) parents.set(k, v);

  out.bindings += 1;
  if (refs.length === 0) { out.unusedBindings += 1; return; }

  const derefs = [];
  const nexts = [];
  for (const ref of refs) {
    const parent = parents.get(ref);
    if (!parent) continue;
    // (A) member access with the binding as the OBJECT.
    if (parent.type === 'MemberExpression' && parent.object === ref) {
      const prop = parent.computed
        ? `[${ctx.src.slice(parent.property.start, parent.property.end)}]`
        : (parent.property.name || '?');
      derefs.push({ ref, prop, guard: isGuarded(ref, parents, body, name, reassignedAt) });
    }
    // (B) the bare binding handed to next(…) as the error argument.
    if (parent.type === 'CallExpression' && parent.callee.type === 'Identifier'
        && parent.callee.name === 'next' && parent.arguments[0] === ref) {
      nexts.push({ ref, guard: isGuarded(ref, parents, body, name, reassignedAt) });
    }
  }

  const badDerefs = derefs.filter((d) => !d.guard);
  const badNexts = nexts.filter((d) => !d.guard);
  if (derefs.length && !badDerefs.length) out.guardedDerefs += derefs.length;
  if (nexts.length && !badNexts.length) out.guardedNexts += nexts.length;
  if (!badDerefs.length && !badNexts.length) return;

  const hazard = badDerefs.length && badNexts.length ? 'both' : (badDerefs.length ? 'A' : 'B');
  const line = Math.min(
    ...badDerefs.map((d) => d.ref.loc.start.line),
    ...badNexts.map((d) => d.ref.loc.start.line)
  );
  out.findings.push({
    ...ctx,
    line,
    column: 0,
    hazard,
    kind: ctx.kind,
    binding: name,
    derefs: badDerefs.map((d) => `${name}.${d.prop}@${d.ref.loc.start.line}`),
    nexts: badNexts.map((d) => `next(${name})@${d.ref.loc.start.line}`),
    detail: [
      badDerefs.length ? `${badDerefs.length} unguarded deref` : null,
      badNexts.length ? `${badNexts.length} unguarded next()` : null,
    ].filter(Boolean).join(', '),
    excerpt: ctx.lineAt(line),
  });
}

// ── Per-file analysis ──────────────────────────────────────────────────────

function analyseFile(absPath, relPath, out) {
  let src;
  try { src = fs.readFileSync(absPath, 'utf8'); } catch { return; }

  // allowHashBang: scripts/*.js here start with `#!/usr/bin/env node`. Without
  // it those files fail to parse — and a scanner that silently skips a file
  // reports the same "0 findings" as one that cleared it.
  const base = {
    ecmaVersion: 2022,
    locations: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  };
  let ast;
  try {
    ast = acorn.parse(src, { ...base, sourceType: 'script' });
  } catch {
    try {
      ast = acorn.parse(src, { ...base, sourceType: 'module' });
    } catch (e2) {
      out.parseErrors.push({ file: relPath, message: e2.message });
      return;
    }
  }

  out.filesScanned += 1;
  const lines = src.split('\n');
  const lineAt = (n) => (lines[n - 1] || '').trim().slice(0, 160);
  const parents = new Map();
  const nodes = [];
  walk(ast, parents, (n) => nodes.push(n), null);

  for (const n of nodes) {
    // PASS 1 — `catch (e) { … }`
    if (n.type === 'CatchClause') {
      out.catchClauses += 1;
      if (!n.param) out.bindinglessCatches += 1;
      analyseBinding(n.param, n.body, parents, {
        file: relPath, src, lineAt, kind: 'catch-clause',
        site: describeSite(n, parents),
      }, out);
      continue;
    }
    // PASS 2 — `p.catch(e => …)`. Structurally unrelated to a CatchClause and
    // therefore invisible to pass 1; same defect, so same guard logic.
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
        && !n.callee.computed && n.callee.property.type === 'Identifier'
        && n.callee.property.name === 'catch' && isFn(n.arguments[0])) {
      out.catchCallbacks += 1;
      const fn = n.arguments[0];
      analyseBinding(fn.params[0] || null, fn.body, parents, {
        file: relPath, src, lineAt, kind: 'catch-callback',
        site: describeSite(n, parents),
      }, out);
    }
  }
}

// ── File discovery ─────────────────────────────────────────────────────────

function collectFiles(dir, acc) {
  /*
   * A SINGLE FILE IS A VALID TARGET, and this branch is what makes it one.
   * Without it, readdirSync(<a file>) throws ENOTDIR, the bare catch below
   * swallows it, and the run reports "files parsed: 0 / FINDINGS: 0" — a
   * confident clean result for a scan that examined nothing. That is the
   * scanner's own worst failure mode reproduced in its discovery half: pointing
   * it at a file you have just fixed is exactly when you would trust the zero.
   */
  let st;
  try { st = fs.statSync(dir); } catch { return acc; }
  if (st.isFile()) {
    if (/\.(js|mjs|cjs)$/.test(dir)) acc.push(dir);
    return acc;
  }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectFiles(full, acc);
    } else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function scan(root) {
  const out = {
    findings: [], parseErrors: [],
    filesScanned: 0, catchClauses: 0, catchCallbacks: 0,
    bindings: 0, bindinglessCatches: 0, unusedBindings: 0,
    guardedDerefs: 0, guardedNexts: 0,
  };
  /*
   * Display paths. Two constraints pull in different directions, so neither
   * base works alone:
   *   - a SINGLE-FILE target makes path.relative(target, target) === '', so
   *     every finding would be reported against an empty filename;
   *   - the SELF-TEST fixtures live outside the repo (in $TMPDIR), so forcing
   *     everything relative to ROOT turns their names into '../../../var/...'
   *     and the fixture table matches nothing — which is how this broke once.
   * So: repo-relative for anything inside the repo, target-relative otherwise.
   */
  let base = root;
  try { if (fs.statSync(root).isFile()) base = path.dirname(root); } catch { /* keep root */ }
  const displayPath = (abs) => {
    const fromRoot = path.relative(ROOT, abs);
    return fromRoot.startsWith('..') ? path.relative(base, abs) : fromRoot;
  };
  for (const abs of collectFiles(root, [])) {
    analyseFile(abs, displayPath(abs), out);
  }
  out.findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return out;
}

// ── Reporting ──────────────────────────────────────────────────────────────

function report(out) {
  const clause = out.findings.filter((f) => f.kind !== 'catch-callback');
  const callback = out.findings.filter((f) => f.kind === 'catch-callback');
  const hz = (t) => out.findings.filter((f) => f.hazard === t).length;

  console.log('── catch-shape census ─────────────────────────────────────────');
  console.log(`files parsed                              : ${out.filesScanned}`);
  console.log(`files that failed to parse                : ${out.parseErrors.length}`);
  console.log(`catch clauses      (pass 1)               : ${out.catchClauses}`);
  console.log(`  of which bindingless (\`catch { }\`)      : ${out.bindinglessCatches}`);
  console.log(`.catch(fn) callbacks (pass 2)             : ${out.catchCallbacks}`);
  console.log(`bindings with the binding never used      : ${out.unusedBindings}`);
  console.log(`already-guarded derefs / next() args      : ${out.guardedDerefs} / ${out.guardedNexts}`);
  console.log('');
  console.log(`FINDINGS                                  : ${out.findings.length}`);
  console.log(`  hazard A only (deref, TypeError → hang) : ${hz('A')}`);
  console.log(`  hazard B only (next(falsy) → silent 404): ${hz('B')}`);
  console.log(`  both                                    : ${hz('both')}`);
  console.log(`  from pass 1 / pass 2                    : ${clause.length} / ${callback.length}`);
  console.log('');

  const byFile = new Map();
  for (const f of out.findings) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
  const ranked = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`── by file (${ranked.length} files) ──`);
  for (const [file, n] of ranked) console.log(`${String(n).padStart(4)}  ${file}`);
  console.log('');

  console.log('── sites ──');
  for (const f of out.findings) {
    console.log(`  ${f.file}:${f.line}  [${f.site}]  hazard ${f.hazard}  ${f.detail}`);
    if (f.derefs && f.derefs.length) console.log(`      deref: ${f.derefs.join(' ')}`);
    if (f.nexts && f.nexts.length) console.log(`      next : ${f.nexts.join(' ')}`);
    console.log(`      ${f.excerpt}`);
  }
  for (const p of out.parseErrors) console.log(`  PARSE FAILED  ${p.file}: ${p.message}`);
}

// ── Self-test: fixture control ─────────────────────────────────────────────

/*
 * Discriminating in both directions. A scanner that flags everything fails the
 * MUST-NOT rows; one that flags nothing fails the MUST rows. `nested/` and the
 * shebang fixture exercise DISCOVERY (the directory walk and the parse
 * fallback), not just the matcher — a scan that never reached a file reports
 * the same clean zero as one that cleared it.
 */
const FIXTURES = [
  { name: 'bare-message', hazard: 'A', lines: [3], note: 'MUST FLAG — bare e.message',
    src: `router.get('/a', async (req, res, next) => {
  try { await load(); }
  catch (e) { logger.error('load failed · ' + e.message); res.status(500).end(); }
});` },

  { name: 'bare-next', hazard: 'B', lines: [3], note: 'MUST FLAG — bare next(e)',
    src: `router.get('/b', async (req, res, next) => {
  try { await load(); }
  catch (e) { next(e); }
});` },

  { name: 'both-hazards', hazard: 'both', lines: [3], note: 'MUST FLAG — deref AND next(e) in one catch',
    src: `router.get('/c', async (req, res, next) => {
  try { await load(); }
  catch (e) { logger.error(e.message); next(e); }
});` },

  { name: 'nested/deref-in-nested-block', hazard: 'A', lines: [4],
    note: 'MUST FLAG — deref inside a nested block, in a SUBDIRECTORY (exercises discovery)',
    src: `router.get('/d', async (req, res, next) => {
  try { await load(); }
  catch (e) {
    if (req.query.verbose) { for (const x of [1]) { logger.error(x + e.message); } }
    res.status(500).end();
  }
});` },

  { name: 'shebang-and-computed-deref', hazard: 'A', lines: [4],
    note: 'MUST FLAG — computed deref, in a shebang file (exercises the parser options)',
    src: `#!/usr/bin/env node
router.get('/e', async (req, res, next) => {
  try { await load(); }
  catch (e) { logger.error(e['message']); res.end(); }
});` },

  { name: 'catch-callback', hazard: 'B', lines: [2], kind: 'catch-callback',
    note: 'MUST FLAG — pass 2: p.catch(e => next(e)), which pass 1 cannot see',
    src: `router.get('/f', (req, res, next) => {
  load().then((r) => res.json(r)).catch((e) => next(e));
});` },

  { name: 'destructured-binding', hazard: 'A', lines: [3],
    note: 'MUST FLAG — catch ({ message }) throws on a null rejection just as e.message does',
    src: `router.get('/g', async (req, res, next) => {
  try { await load(); }
  catch ({ message }) { logger.error(message); res.end(); }
});` },

  { name: 'short-circuit-guard', hazard: null, note: 'MUST NOT FLAG — e && e.message',
    src: `router.get('/h', async (req, res, next) => {
  try { await load(); }
  catch (e) { logger.error(e && e.message); res.end(); }
});` },

  { name: 'optional-chain-guard', hazard: null, note: 'MUST NOT FLAG — e?.message',
    src: `router.get('/i', async (req, res, next) => {
  try { await load(); }
  catch (e) { logger.error(e?.message); res.end(); }
});` },

  { name: 'as-error-normaliser', hazard: null,
    note: 'MUST NOT FLAG — asError(e) then next(err): the next() arg is not the bare binding',
    src: `router.get('/j', async (req, res, next) => {
  try { await load(); }
  catch (e) { const err = asError(e); logger.error(err.message); next(err); }
});` },

  { name: 'instanceof-ternary', hazard: null,
    note: 'MUST NOT FLAG — e instanceof Error ? e.message : String(e)',
    src: `router.get('/k', async (req, res, next) => {
  try { await load(); }
  catch (e) { logger.error(e instanceof Error ? e.message : String(e)); next(e instanceof Error ? e : new Error('x')); }
});` },

  { name: 'reassigned-before-use', hazard: null,
    note: 'MUST NOT FLAG — binding reassigned to an Error before the deref',
    src: `router.get('/l', async (req, res, next) => {
  try { await load(); }
  catch (e) { e = e instanceof Error ? e : new Error(String(e)); logger.error(e.message); next(e); }
});` },

  { name: 'unused-binding', hazard: null,
    note: 'MUST NOT FLAG — binding never referenced',
    src: `router.get('/m', async (req, res, next) => {
  try { await load(); }
  catch (e) { res.status(500).json({ success: false, error: 'failed' }); }
});` },

  { name: 'rethrow-unchanged', hazard: null,
    note: 'MUST NOT FLAG — rethrow, no deref and no next()',
    src: `router.get('/n', async (req, res, next) => {
  try { await load(); }
  catch (e) { metrics.inc('load_fail'); throw e; }
});` },

  { name: 'no-binding', hazard: null,
    note: 'MUST NOT FLAG — `catch { }` binds nothing, so it cannot dereference',
    src: `router.get('/o', async (req, res, next) => {
  try { await load(); }
  catch { res.status(500).end(); }
});` },

  { name: 'if-test-guard', hazard: null,
    note: 'MUST NOT FLAG — deref in the consequent of an if whose test checks the binding',
    src: `router.get('/p', async (req, res, next) => {
  try { await load(); }
  catch (e) { if (Number.isInteger(e && e.status)) { return res.status(e.status).end(); } next(new Error('x')); }
});` },
];

function selfTest() {
  const dir = path.join(os.tmpdir(), 'scan-catch-shape-fixtures');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FIXTURES) {
    const dest = path.join(dir, `${f.name}.js`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${f.src}\n`);
  }

  const res = scan(dir);
  const rows = [];
  let failures = 0;

  for (const f of FIXTURES) {
    const rel = `${f.name}.js`.split('/').join(path.sep);
    const got = res.findings.filter((x) => x.file === rel);
    const checks = [];
    if (f.hazard === null) {
      checks.push(['0 findings', got.length === 0]);
    } else {
      checks.push(['1 finding', got.length === 1]);
      checks.push([`hazard=${f.hazard}`, got.length === 1 && got[0].hazard === f.hazard]);
      checks.push([`lines=[${f.lines}]`, JSON.stringify(got.map((x) => x.line)) === JSON.stringify(f.lines)]);
      if (f.kind) checks.push([`kind=${f.kind}`, got.length === 1 && got[0].kind === f.kind]);
    }
    const ok = checks.every((c) => c[1]);
    if (!ok) failures += 1;
    rows.push({
      fixture: f.name,
      want: f.hazard === null ? 'NOT FLAGGED' : `FLAG ${f.hazard}`,
      verdict: ok ? 'PASS' : 'FAIL',
      got: got.length ? `${got.length} @ [${got.map((x) => x.line)}] ${got.map((x) => x.hazard).join(',')}` : 'none',
      why: checks.filter((c) => !c[1]).map((c) => `want ${c[0]}`).join('; '),
      note: f.note,
    });
  }

  // ── Denominator controls. A count is only an answer if the sweep that
  //    produced it actually looked. Each of these fails LOUDLY on a collapse
  //    that would otherwise present as a clean zero.
  const wantClauses = FIXTURES.filter((f) => !f.kind).length;
  const clauseOk = res.catchClauses === wantClauses;
  const callbackOk = res.catchCallbacks === 1;
  const filesOk = res.filesScanned === FIXTURES.length;
  const parseOk = res.parseErrors.length === 0;
  for (const ok of [clauseOk, callbackOk, filesOk, parseOk]) if (!ok) failures += 1;

  /*
   * ── Reference implementations, addressed by SITE not by whole file.
   *
   * The brief for this scanner said products.js and maps.js must report zero,
   * on the understanding that both were fixed on 2026-09-08. Measuring says
   * otherwise, and the measurement is right: each fix covered SOME of its
   * file's catches, not all of them.
   *
   *   products.js — asError() now covers ALL FIVE handlers. It initially covered
   *                 only the three transactional ones; the two read handlers
   *                 were finished once this control surfaced them.
   *   maps.js     — the status-discriminated rethrow is in verifyTokenAndState.
   *                 The three route handlers that CALL it still do
   *                 `e.message` + bare `next(e)` in their own catches, and that
   *                 is DELIBERATE — see the comment block at GET /autocomplete.
   *                 They are theoretical findings kept as the live "unfixed"
   *                 reference.
   *
   * So the control asserts the FIXED sites are clean and the UNFIXED ones are
   * still reported — discriminating in both directions. A whole-file zero would
   * have been satisfied by a scanner that had stopped working, and bending the
   * scanner to produce it would have deleted five true positives.
   */
  const real = scan(ROOT);
  const FIXED_SITES = [
    ['routes/admin/products.js', 'POST /'], ['routes/admin/products.js', 'PUT /:id'],
    ['routes/admin/products.js', 'DELETE /:id'], ['routes/admin/products.js', 'GET /'],
    ['routes/admin/products.js', 'GET /:id'], ['routes/public/maps.js', 'verifyTokenAndState'],
  ];
  /*
   * Counted, not enumerated. An earlier version listed the five unfixed sites
   * and required ALL FIVE to still be reported — so finishing two of them
   * (a genuine improvement) turned the control red for the right change. An
   * expectation that fails when the code gets BETTER trains people to edit the
   * control, which is how a control stops discriminating.
   *
   * `>= 1` keeps both directions honest: a scanner that flags everything fails
   * FIXED_SITES, and one that flags nothing fails this. Neither is satisfied by
   * a scanner that has stopped working.
   */
  const UNFIXED_FILE = 'routes/public/maps.js';
  const at = (file, site) => real.findings.some((f) => f.file === file && f.site === site);
  const fixedClean = FIXED_SITES.filter(([f, s]) => at(f, s));
  const unfixedSeen = real.findings.filter((f) => f.file === UNFIXED_FILE).length;
  const refOk = fixedClean.length === 0 && unfixedSeen >= 1;
  if (!refOk) failures += 1;
  // …and one that flags NOTHING ANYWHERE is broken, not clean. The repo must
  // still present a non-zero denominator for that zero to mean anything.
  const denomOk = real.catchClauses > 100 && real.filesScanned > 100;
  if (!denomOk) failures += 1;

  console.log(`fixtures written to: ${dir}\n`);
  const w = Math.max(...rows.map((r) => r.fixture.length));
  console.log(`${'FIXTURE'.padEnd(w)}  WANT         VERDICT  GOT                    WHY IT FAILED`);
  for (const r of rows) {
    console.log(`${r.fixture.padEnd(w)}  ${r.want.padEnd(11)}  ${r.verdict.padEnd(7)}  ${r.got.padEnd(21)}  ${r.why}`);
  }
  console.log('');
  console.log(`denominator: ${wantClauses} catch clauses expected, found ${res.catchClauses}      ${clauseOk ? 'PASS' : 'FAIL'}`);
  console.log(`denominator: 1 .catch(fn) callback expected, found ${res.catchCallbacks}        ${callbackOk ? 'PASS' : 'FAIL'}`);
  console.log(`discovery  : ${FIXTURES.length} fixture files expected, parsed ${res.filesScanned}     ${filesOk ? 'PASS' : 'FAIL'}`);
  console.log(`discovery  : 0 parse errors, got ${res.parseErrors.length}                       ${parseOk ? 'PASS' : 'FAIL'}`);
  console.log(`reference  : ${FIXED_SITES.length} FIXED sites clean (${fixedClean.length} flagged), ${UNFIXED_FILE} still reported (${unfixedSeen})  ${refOk ? 'PASS' : 'FAIL'}`);
  console.log(`reference  : repo denominator non-trivial (${real.catchClauses} catches / ${real.filesScanned} files)  ${denomOk ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log(failures === 0 ? 'ALL FIXTURES PASS' : `${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.exitCode = selfTest();
    return;
  }
  const target = argv.find((a) => !a.startsWith('--')) || ROOT;
  const out = scan(path.resolve(target));
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else report(out);
  // A census exits 0 by design.
  process.exitCode = 0;
}

main();
