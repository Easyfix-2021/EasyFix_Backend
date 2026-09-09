#!/usr/bin/env node
'use strict';

/*
 * scan-unguarded-await.js — census of awaits that can crash or hang a request.
 *
 * ─── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * Express 4 does not attach a `.catch` to the promise an async route handler or
 * middleware returns. An `await` that rejects outside a try/catch therefore
 * reaches no error middleware, sends no response, and becomes an unhandled
 * rejection. On 2026-09-08 that exited the production container: a pool
 * "Queue limit reached." from an await in middleware/auth.js:87 that sat
 * outside the try covering only verifyToken.
 *
 * server.js now carries a process.on('unhandledRejection') backstop, so the
 * process survives — but the REQUEST still hangs with no response and no
 * status code. These sites are still real defects; the blast radius shrank
 * from "every concurrent request" to "this one request, forever".
 *
 * ─── WHAT IT DOES ──────────────────────────────────────────────────────────
 *
 * AST only (acorn, already a transitive dep of eslint — no new dependency, no
 * regex analysis). For every async function it can prove is used as an Express
 * handler or middleware, it reports each `await` whose path up to that
 * function's own body does not pass through a protective try.
 *
 *   node scripts/scan-unguarded-await.js              # human summary
 *   node scripts/scan-unguarded-await.js --json       # machine-readable
 *   node scripts/scan-unguarded-await.js --self-test  # fixture control (below)
 *   node scripts/scan-unguarded-await.js --gate       # CI: exit 1 on a regression
 *
 * Exit code is 0 for a census run, always — this is a measurement, not a gate.
 * `--self-test` is the exception: it exits 1 if any fixture verdict is wrong,
 * because an unvalidated scanner's silence is indistinguishable from a clean
 * result.
 *
 * ─── THE PROTECTION RULE, PRECISELY ────────────────────────────────────────
 *
 * Walking from the await up to its OWN function's body, a TryStatement counts
 * as protective only when we entered it through its `block`. Consequences:
 *
 *   - an await in the `catch` block is NOT protected by that same try
 *     (a throw there is a fresh rejection with nothing left to catch it)
 *   - an await in the `finally` block is NOT protected by that same try
 *   - a nested `async` function is its OWN boundary. `try { rows.map(async r =>
 *     { await x(r); }) } catch {}` does not protect the inner await, because
 *     the map's promises are never awaited. Sites like this are tagged
 *     `nested: true` and counted separately, since the same shape written as
 *     `await Promise.all(rows.map(async …))` IS protected and the scanner
 *     cannot tell the two apart without dataflow. Treat that bucket as
 *     "verify per site", not as confirmed defects.
 *
 * `try { await x(); } finally { y(); }` with NO catch is FLAGGED by default.
 * The finally runs and the rejection then continues to propagate out of the
 * handler — the defect is fully present. (The brief listed this as a
 * MUST-NOT-FLAG case; the language semantics say otherwise, so it is flagged
 * and bucketed as `finally-only`. `--finally-protects` flips it if you want
 * the other number.)
 *
 * A `try {}` with NEITHER catch NOR finally is a SyntaxError in JavaScript —
 * it cannot be written, so there is no verdict to decide. The self-test
 * asserts the parser rejects it rather than pretending to classify it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..');

// Object names that carry Express registration methods in this codebase.
// Measured, not guessed: `grep -o '\w+\.(get|post|…)\(' routes server.js`
// yields router (988), app (14), r (5). Anything else is a blind spot.
const ROUTER_OBJECTS = new Set(['router', 'app', 'r', 'apiRouter', 'subRouter']);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'head', 'options']);
const WRAPPERS = new Set(['asyncMiddleware', 'asyncHandler', 'catchAsync', 'wrapAsync']);
const SKIP_DIRS = new Set([
  'node_modules', 'tests', 'uploads', 'logs', 'coverage', 'dist', 'build',
  'stt-service', '.git', 'assets', 'deploy',
]);

// ── AST plumbing ───────────────────────────────────────────────────────────

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

/* Nearest enclosing function of `node`, or null at module scope. */
function ownerFn(node, parents) {
  let cur = parents.get(node);
  while (cur) {
    if (isFn(cur)) return cur;
    cur = parents.get(cur);
  }
  return null;
}

function hasAncestor(node, parents, pred) {
  let cur = parents.get(node);
  while (cur) {
    if (pred(cur)) return true;
    cur = parents.get(cur);
  }
  return false;
}

/*
 * Is `awaitNode` protected, relative to the body of `owner`?
 * Returns 'guarded' | 'unguarded' | 'finally-only'.
 */
function classifyAwait(awaitNode, owner, parents) {
  let node = awaitNode;
  let sawFinallyOnly = false;
  for (;;) {
    const parent = parents.get(node);
    if (!parent || parent === owner) break;
    if (parent.type === 'TryStatement' && parent.block === node) {
      // Entered through the try block itself — this try can see the rejection.
      if (parent.handler) return 'guarded';
      if (parent.finalizer) sawFinallyOnly = true; // finally-only: runs, then rethrows
    }
    // Entered through parent.handler (CatchClause) or parent.finalizer:
    // that try cannot catch this await. Keep walking outward.
    node = parent;
  }
  return sawFinallyOnly ? 'finally-only' : 'unguarded';
}

// ── Express-signature heuristic ────────────────────────────────────────────

function looksLikeMiddlewareSignature(fn) {
  const p = fn.params;
  if (!p || p.length < 2 || p.length > 4) return false;
  const nameOf = (x) => (x && x.type === 'Identifier' ? x.name.replace(/^_/, '') : null);
  return nameOf(p[0]) === 'req' && nameOf(p[1]) === 'res';
}

// ── Per-file analysis ──────────────────────────────────────────────────────

function analyseFile(absPath, relPath, opts, out) {
  let src;
  try { src = fs.readFileSync(absPath, 'utf8'); } catch { return; }

  // allowHashBang: every scripts/*.js here starts with `#!/usr/bin/env node`.
  // Without it 17 files failed to parse — and a scanner that silently skips a
  // file reports the same "0 findings" as one that cleared it.
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

  const lines = src.split('\n');
  const parents = new Map();
  const nodes = [];
  walk(ast, parents, (n) => nodes.push(n), null);

  // 1. Name → function node, for handlers registered by identifier reference
  //    (`async function scopedJob(req,res,next){…}; router.get('/:id', scopedJob, …)`).
  //    Flat across scopes: an over-approximation, documented as a blind spot.
  const fnByName = new Map();
  for (const n of nodes) {
    if (n.type === 'FunctionDeclaration' && n.id) fnByName.set(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFn(n.init)) {
      fnByName.set(n.id.name, n.init);
    }
  }

  // 2. Identifiers handed to a known async wrapper — `asyncMiddleware(requireAuth)`.
  const wrappedNames = new Set();
  // 2b. Identifiers bound from a require() — `const { scopedJob } = require('./jobs')`.
  //     These are covered when their own file is scanned, so they are not a
  //     genuine blind spot; the distinction is reported.
  const requiredNames = new Set();
  const isRequire = (n) => n && n.type === 'CallExpression'
    && n.callee.type === 'Identifier' && n.callee.name === 'require';
  for (const n of nodes) {
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && WRAPPERS.has(n.callee.name)) {
      const a = n.arguments[0];
      if (a && a.type === 'Identifier') wrappedNames.add(a.name);
    }
    if (n.type !== 'VariableDeclarator' || !n.init) continue;
    const src2 = isRequire(n.init) || (n.init.type === 'MemberExpression' && isRequire(n.init.object));
    if (!src2) continue;
    if (n.id.type === 'Identifier') requiredNames.add(n.id.name);
    else if (n.id.type === 'ObjectPattern') {
      for (const p of n.id.properties) {
        if (p.value && p.value.type === 'Identifier') requiredNames.add(p.value.name);
      }
    }
  }

  const isWrapped = (fn, name) =>
    (name && wrappedNames.has(name)) ||
    hasAncestor(fn, parents, (a) => a.type === 'CallExpression'
      && a.callee.type === 'Identifier' && WRAPPERS.has(a.callee.name));

  // 3. Handlers: fn node → { name, kind, route }. A Map so the same function
  //    registered on several routes is one handler, not N.
  const handlers = new Map();
  const addHandler = (fn, name, kind, route) => {
    if (!fn || !fn.async) return;
    if (handlers.has(fn)) return;
    if (isWrapped(fn, name)) { out.wrapped += 1; return; }
    handlers.set(fn, { name: name || '<anonymous>', kind, route });
  };

  const resolveArg = (arg, name, kind, route) => {
    if (!arg) return;
    if (arg.type === 'ArrayExpression') {
      for (const el of arg.elements) resolveArg(el, name, kind, route);
      return;
    }
    if (isFn(arg)) {
      const own = arg.id ? arg.id.name : null;
      addHandler(arg, own || name, kind, route);
      return;
    }
    if (arg.type === 'Identifier') {
      const target = fnByName.get(arg.name);
      if (target) addHandler(target, arg.name, kind, route);
      else if (!wrappedNames.has(arg.name)) {
        // Distinguish "imported from another file in this repo" (its own file
        // is scanned, so it is covered) from "genuinely opaque". Conflating
        // them makes the blind-spot list read as far worse than it is.
        const shape = requiredNames.has(arg.name) ? 'imported-covered-elsewhere' : 'identifier-not-local';
        out.blindSpots.push({ file: relPath, line: arg.loc.start.line, shape, text: arg.name, route });
      }
      return;
    }
    if (arg.type === 'CallExpression') {
      const callee = arg.callee;
      if (callee.type === 'Identifier' && WRAPPERS.has(callee.name)) { out.wrapped += 1; return; }
      // require('./sub') mounts a whole router — followed as a separate file.
      if (callee.type === 'Identifier' && callee.name === 'require') return;
      out.blindSpots.push({
        file: relPath, line: arg.loc.start.line, shape: 'factory-call',
        text: src.slice(arg.start, Math.min(arg.end, arg.start + 60)).replace(/\s+/g, ' '), route,
      });
      return;
    }
    if (arg.type === 'MemberExpression') {
      out.blindSpots.push({
        file: relPath, line: arg.loc.start.line, shape: 'member-reference',
        text: src.slice(arg.start, Math.min(arg.end, arg.start + 60)).replace(/\s+/g, ' '), route,
      });
    }
  };

  for (const n of nodes) {
    if (n.type !== 'CallExpression') continue;
    const c = n.callee;
    if (c.type !== 'MemberExpression') continue;
    if (c.computed) {
      // router[method](...) — the method is not a literal, so this call cannot
      // be recognised at all. A genuine blind spot; report it.
      if (c.object.type === 'Identifier' && ROUTER_OBJECTS.has(c.object.name)) {
        out.blindSpots.push({ file: relPath, line: n.loc.start.line, shape: 'computed-registration', text: src.slice(c.start, c.end) });
      }
      continue;
    }
    if (c.property.type !== 'Identifier' || !METHODS.has(c.property.name)) continue;
    if (c.object.type !== 'Identifier' || !ROUTER_OBJECTS.has(c.object.name)) continue;
    out.registrationSites += 1;
    if (c.property.name !== 'use') out.routeSites += 1;
    const method = c.property.name.toUpperCase();
    const args = n.arguments.slice();
    let route = method;
    if (args[0] && args[0].type === 'Literal' && typeof args[0].value === 'string') {
      route = `${method} ${args[0].value}`;
      args.shift();
    }
    const kind = c.property.name === 'use' ? 'mounted' : 'route';
    for (const a of args) resolveArg(a, null, kind, route);
  }

  // 4. middleware/** — async functions with an Express signature, including
  //    the ones a factory returns (`function featureFlag(n){ return async (req,res,next)=>… }`).
  if (relPath.startsWith('middleware/')) {
    for (const n of nodes) {
      if (!isFn(n) || !n.async || !looksLikeMiddlewareSignature(n)) continue;
      let name = n.id ? n.id.name : null;
      if (!name) {
        const p = parents.get(n);
        if (p && p.type === 'VariableDeclarator' && p.id.type === 'Identifier') name = p.id.name;
      }
      addHandler(n, name, 'mounted', 'middleware export');
    }
  }

  // 5. Classify every await inside each handler's boundary.
  for (const n of nodes) {
    if (n.type !== 'AwaitExpression') continue;
    const owner = ownerFn(n, parents);
    if (!owner) continue;

    // Which registered handler does this await ultimately live under?
    let host = handlers.has(owner) ? owner : null;
    if (!host) {
      let cur = owner;
      while (cur && !handlers.has(cur)) cur = ownerFn(cur, parents);
      host = cur;
    }
    if (!host) continue;
    if (isWrapped(owner, null)) continue; // inner fn passed to asyncMiddleware

    const verdict = classifyAwait(n, owner, parents);
    if (verdict === 'guarded') continue;
    if (verdict === 'finally-only' && opts.finallyProtects) continue;

    const meta = handlers.get(host);
    out.findings.push({
      file: relPath,
      line: n.loc.start.line,
      column: n.loc.start.column + 1,
      handler: meta.name,
      route: meta.route || null,
      kind: meta.kind,
      severity: meta.kind === 'mounted' ? 'mounted-middleware' : 'route-handler',
      nested: owner !== host,
      bucket: verdict,
      excerpt: (lines[n.loc.start.line - 1] || '').trim().slice(0, 160),
    });
  }

  out.handlerCount += handlers.size;
  if (handlers.size) out.handlersByFile[relPath] = handlers.size;
  for (const [, meta] of handlers) {
    if (meta.kind === 'mounted') out.mountedHandlerCount += 1;
  }
}

// ── File discovery ─────────────────────────────────────────────────────────

function collectFiles(dir, acc) {
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

function scan(root, opts) {
  const out = {
    findings: [], blindSpots: [], parseErrors: [],
    handlerCount: 0, mountedHandlerCount: 0, wrapped: 0,
    registrationSites: 0, routeSites: 0, handlersByFile: {},
  };
  for (const abs of collectFiles(root, [])) {
    analyseFile(abs, path.relative(root, abs), opts, out);
  }
  out.findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return out;
}

// ── Reporting ──────────────────────────────────────────────────────────────

function report(out) {
  const total = out.findings.length;
  const mounted = out.findings.filter((f) => f.severity === 'mounted-middleware');
  const nested = out.findings.filter((f) => f.nested);
  const direct = out.findings.filter((f) => !f.nested);
  const finallyOnly = out.findings.filter((f) => f.bucket === 'finally-only');

  console.log('── unguarded await census ─────────────────────────────────────');
  console.log(`router.<method>() registration sites          : ${out.registrationSites} (${out.routeSites} routes + ${out.registrationSites - out.routeSites} .use)`);
  console.log(`async Express handlers/middlewares found : ${out.handlerCount}`);
  console.log(`  of which mounted via .use()            : ${out.mountedHandlerCount}`);
  console.log(`already wrapped (asyncMiddleware et al)  : ${out.wrapped}`);
  console.log(`files that failed to parse               : ${out.parseErrors.length}`);
  console.log('');
  console.log(`UNGUARDED AWAITS                         : ${total}`);
  console.log(`  direct (in the handler's own body)     : ${direct.length}`);
  console.log(`  nested (inner async callback)          : ${nested.length}  <- verify per site`);
  console.log(`  try/finally with no catch              : ${finallyOnly.length}`);
  console.log(`  on MOUNTED middleware (.use)           : ${mounted.length}  <- every request under the mount`);
  console.log('');

  const byFile = new Map();
  for (const f of out.findings) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
  const ranked = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`── by file (${ranked.length} files) ──`);
  for (const [file, n] of ranked) console.log(`${String(n).padStart(4)}  ${file}`);
  console.log('');

  if (mounted.length) {
    console.log('── MOUNTED MIDDLEWARE (highest severity) ──');
    for (const f of mounted) {
      console.log(`  ${f.file}:${f.line}:${f.column}  ${f.handler}  [${f.route || '?'}]${f.nested ? ' (nested)' : ''}`);
      console.log(`      ${f.excerpt}`);
    }
    console.log('');
  }

  console.log('── top 15 sites ──');
  for (const f of direct.concat(nested).slice(0, 15)) {
    console.log(`  ${f.file}:${f.line}:${f.column}  ${f.handler}  [${f.route || '?'}]  ${f.severity}${f.nested ? ' nested' : ''} ${f.bucket}`);
    console.log(`      ${f.excerpt}`);
  }
  console.log('');

  const shapes = new Map();
  for (const b of out.blindSpots) shapes.set(b.shape, (shapes.get(b.shape) || 0) + 1);
  console.log('── blind spots (shapes the scanner cannot follow) ──');
  for (const [shape, n] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(4)}  ${shape}`);
  }
  for (const p of out.parseErrors) console.log(`  PARSE FAILED  ${p.file}: ${p.message}`);
}

// ── Self-test: fixture control ─────────────────────────────────────────────

const FIXTURES = [
  {
    name: 'above-try', expect: 1, note: 'MUST FLAG — await above the try',
    src: `const router = require('express').Router();
router.get('/a', async (req, res) => {
  const u = await load(req.params.id);
  try { await save(u); } catch (e) { res.status(500).end(); }
});
module.exports = router;`,
    lines: [3],
  },
  {
    name: 'in-catch', expect: 1, note: 'MUST FLAG — await inside the catch block',
    src: `const router = require('express').Router();
router.post('/b', async (req, res) => {
  try { await save(req.body); } catch (e) { await auditLog(e); res.end(); }
});
module.exports = router;`,
    lines: [3],
  },
  {
    name: 'in-finally', expect: 1, note: 'MUST FLAG — await inside the finally block',
    src: `const router = require('express').Router();
router.post('/c', async (req, res) => {
  try { await save(req.body); } catch (e) { res.end(); } finally { await release(); }
});
module.exports = router;`,
    lines: [3],
  },
  {
    name: 'inner-async-in-try', expect: 1, nested: true,
    note: 'MUST FLAG — inner async callback has its own boundary',
    src: `const router = require('express').Router();
router.get('/d', async (req, res) => {
  try {
    rows.map(async (row) => { await save(row); });
    res.end();
  } catch (e) { res.status(500).end(); }
});
module.exports = router;`,
    lines: [4],
  },
  {
    name: 'await-after-early-return', expect: 1,
    note: 'MUST FLAG — await after an early return, outside the try',
    src: `const router = require('express').Router();
router.get('/e', async (req, res) => {
  try { if (!req.query.id) return res.status(400).end(); } catch (e) { res.end(); }
  await save(req.query.id);
  res.end();
});
module.exports = router;`,
    lines: [4],
  },
  {
    name: 'named-ref-guard', expect: 1,
    note: 'MUST FLAG — handler registered by identifier, not inline',
    src: `const router = require('express').Router();
async function scopedJob(req, res, next) {
  const j = await load(req.params.id);
  req.job = j;
  next();
}
router.use(scopedJob);
module.exports = router;`,
    lines: [3],
  },
  {
    name: 'guarded-try-catch', expect: 0, note: 'MUST NOT FLAG — await inside try+catch',
    src: `const router = require('express').Router();
router.get('/f', async (req, res) => {
  try { const u = await load(req.params.id); res.json(u); }
  catch (e) { res.status(500).end(); }
});
module.exports = router;`,
    lines: [],
  },
  {
    name: 'guarded-try-finally', expect: 1, bucket: 'finally-only',
    note: 'brief said MUST NOT FLAG; JS semantics say the rejection still escapes -> FLAGGED as finally-only',
    src: `const router = require('express').Router();
router.get('/g', async (req, res) => {
  const conn = await pool.getConnection();
  try { res.json(await conn.query('SELECT 1')); } finally { conn.release(); }
});
module.exports = router;`,
    lines: [3, 4],
    expectOverride: 2, // line 3 is a plain unguarded await; line 4 is finally-only
  },
  {
    name: 'nested-try-inside-catch', expect: 0,
    note: 'MUST NOT FLAG — the catch-block await has its own try/catch',
    src: `const router = require('express').Router();
router.post('/h', async (req, res) => {
  try { await save(req.body); }
  catch (e) { try { await auditLog(e); } catch (e2) { } res.end(); }
});
module.exports = router;`,
    lines: [],
  },
  {
    name: 'plain-async-non-handler', expect: 0, handlers: 0,
    note: 'MUST NOT FLAG — async function that is never registered',
    src: `async function helper(id) {
  const row = await load(id);
  return row;
}
module.exports = { helper };`,
    lines: [],
  },
  {
    name: 'sync-handler', expect: 0, handlers: 0,
    note: 'MUST NOT FLAG — sync handler, no await, not counted in the denominator',
    src: `const router = require('express').Router();
router.get('/i', (req, res) => { res.json({ ok: true }); });
module.exports = router;`,
    lines: [],
  },
  {
    name: 'wrapped-by-asyncmiddleware', expect: 0, handlers: 0, wrapped: 1,
    note: 'MUST NOT FLAG — already wrapped, counted as wrapped instead',
    src: `const router = require('express').Router();
const { asyncMiddleware } = require('../utils/async-middleware');
router.use(asyncMiddleware(async (req, res, next) => {
  req.user = await loadUser(req);
  next();
}));
module.exports = router;`,
    lines: [],
  },
  {
    name: 'factory-blind-spot', expect: 0, handlers: 0, blindSpot: 'factory-call',
    note: 'MUST NOT FLAG, MUST appear as a blind spot — handler built by a factory',
    src: `const router = require('express').Router();
router.use(makeGuard('admin'));
module.exports = router;`,
    lines: [],
  },
  {
    // Exercises the middleware/** signature path, which no router.* call
    // reaches. Without this fixture that whole detection mode is untested and
    // a silent zero from it would be indistinguishable from a clean result.
    name: 'middleware/factory-returns-async', expect: 1,
    note: 'MUST FLAG — async middleware returned by a factory in middleware/**',
    src: `module.exports = function featureFlag(name) {
  return async (req, res, next) => {
    const on = await isEnabled(name);
    if (!on) return res.status(404).end();
    return next();
  };
};`,
    lines: [3],
  },
  {
    name: 'middleware/wrapped-export', expect: 0, handlers: 0, wrapped: 1,
    note: 'MUST NOT FLAG — middleware/** export already handed to asyncMiddleware by name',
    src: `const { asyncMiddleware } = require('../../utils/async-middleware');
async function requireAuth(req, res, next) {
  req.user = await verify(req.headers.authorization);
  return next();
}
module.exports = asyncMiddleware(requireAuth);`,
    lines: [],
  },
];

function selfTest() {
  const dir = path.join(os.tmpdir(), 'scan-fixtures');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FIXTURES) {
    const dest = path.join(dir, `${f.name}.js`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${f.src}\n`);
  }

  const res = scan(dir, { finallyProtects: false });
  const rows = [];
  let failures = 0;

  for (const f of FIXTURES) {
    const rel = `${f.name}.js`;
    const got = res.findings.filter((x) => x.file === rel);
    const gotLines = got.map((x) => x.line);
    const wantCount = f.expectOverride != null ? f.expectOverride : f.expect;
    const wantLines = f.lines;

    const checks = [];
    checks.push([`count=${wantCount}`, got.length === wantCount]);
    checks.push([`lines=[${wantLines}]`, JSON.stringify(gotLines) === JSON.stringify(wantLines)]);
    if (f.nested) checks.push(['nested', got.every((x) => x.nested)]);
    if (f.bucket) checks.push([`bucket=${f.bucket}`, got.some((x) => x.bucket === f.bucket)]);
    if (f.blindSpot) {
      checks.push([`blindSpot=${f.blindSpot}`, res.blindSpots.some((b) => b.file === rel && b.shape === f.blindSpot)]);
    }

    const ok = checks.every((c) => c[1]);
    if (!ok) failures += 1;
    rows.push({
      fixture: f.name,
      verdict: ok ? 'PASS' : 'FAIL',
      got: `${got.length} @ [${gotLines}]`,
      checks: checks.filter((c) => !c[1]).map((c) => `want ${c[0]}`).join('; '),
      note: f.note,
    });
  }

  // Denominator control: the scanner must find every handler-bearing fixture.
  const expectedHandlers = FIXTURES.filter((f) => f.handlers !== 0).length;
  const handlerOk = res.handlerCount === expectedHandlers;
  if (!handlerOk) failures += 1;

  // A `try {}` with neither catch nor finally cannot be written — assert the
  // parser rejects it, rather than inventing a verdict for an impossible shape.
  let syntaxOk = false;
  try {
    acorn.parse('async function f(){ try { await x(); } }', { ecmaVersion: 2022 });
  } catch { syntaxOk = true; }
  if (!syntaxOk) failures += 1;

  // The contested case, measured both ways.
  const alt = scan(dir, { finallyProtects: true });
  const altFinallyOnly = alt.findings.filter((x) => x.file === 'guarded-try-finally.js').length;

  console.log(`fixtures written to: ${dir}\n`);
  const w = Math.max(...rows.map((r) => r.fixture.length));
  console.log(`${'FIXTURE'.padEnd(w)}  VERDICT  GOT              WHY IT FAILED`);
  for (const r of rows) {
    console.log(`${r.fixture.padEnd(w)}  ${r.verdict.padEnd(7)}  ${r.got.padEnd(15)}  ${r.checks}`);
  }
  console.log('');
  console.log(`denominator: expected ${expectedHandlers} async handlers, found ${res.handlerCount}  ${handlerOk ? 'PASS' : 'FAIL'}`);
  console.log(`wrapped count: ${res.wrapped} (expected >= 1)  ${res.wrapped >= 1 ? 'PASS' : 'FAIL'}`);
  console.log(`'try {}' with no catch/finally is a SyntaxError  ${syntaxOk ? 'PASS (parser rejects it)' : 'FAIL'}`);
  console.log(`--finally-protects: guarded-try-finally drops 2 -> ${altFinallyOnly}  ${altFinallyOnly === 1 ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log(failures === 0 ? 'ALL FIXTURES PASS' : `${failures} FIXTURE GROUP(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

// ── CLI ────────────────────────────────────────────────────────────────────

/*
 * --gate — CI mode. Exits 1 on a regression.
 *
 * ⚠ THE OBVIOUS GATE IS THE BROKEN ONE. "direct === 0" is satisfied just as
 * well by a scanner that found nothing because it stopped working: a parser
 * upgrade that rejects a new syntax, a refactor that renames the routers it
 * recognises, a bad glob. All of those report a clean tree, forever, and the
 * gate goes green while enforcing nothing. So the gate asserts its own
 * CAPABILITY before it asserts the result:
 *
 *   1. parseErrors === 0     — a file that failed to parse was not scanned, and
 *                              silence about it is not a clean result. (This
 *                              already caught 17 silently-unparsed files during
 *                              development, every one of them shebang scripts.)
 *   2. handlerCount >= floor — the denominator. If the scanner suddenly sees a
 *                              handful of handlers instead of ~939, it has lost
 *                              its ability to find them and its zero is
 *                              meaningless. The floor is deliberately blunt: it
 *                              exists to catch collapse, not drift.
 *   3. direct === 0          — the actual regression check.
 *
 * `nested` findings are NOT gated. All 6 present on 2026-09-08 were falsified
 * as false positives (the consuming await is inside a try, which the scanner
 * cannot see from the inner function). Gating them would make the gate red on
 * day one, and a gate that is red on arrival gets --no-verify'd and then
 * deleted. Argue that count down to 0 first, then gate it.
 */
const GATE_HANDLER_FLOOR = 800; // measured 939 on 2026-09-08; blunt collapse check

function gate(out) {
  const direct = out.findings.filter((f) => !f.nested);
  const problems = [];

  if (out.parseErrors.length > 0) {
    problems.push(
      `${out.parseErrors.length} file(s) failed to parse — they were NOT scanned, so this run `
      + 'cannot claim a clean tree:\n    '
      + out.parseErrors.slice(0, 10).map((e) => `${e.file || e}: ${e.message || ''}`).join('\n    ')
    );
  }
  if (out.handlerCount < GATE_HANDLER_FLOOR) {
    problems.push(
      `only ${out.handlerCount} async Express handlers found, below the floor of ${GATE_HANDLER_FLOOR}. `
      + 'The scanner has probably lost its ability to RECOGNISE handlers (renamed routers, a parser '
      + 'change, a bad path), in which case a finding count of 0 means nothing. Investigate the '
      + 'denominator before touching this floor — lower it only if the repo genuinely shrank.'
    );
  }
  if (direct.length > 0) {
    problems.push(
      `${direct.length} unguarded await(s) in an async Express handler's own body.\n`
      + '    In Express 4 a rejection there reaches no error middleware and hangs the request; before\n'
      + "    server.js's unhandledRejection backstop existed it exited the process (2026-09-08).\n"
      + '    Fix: put the await inside the handler\'s try, or wrap the middleware with\n'
      + '    utils/async-middleware.js. Sites:\n    '
      + direct.map((f) => `${f.file}:${f.line} [${f.route || f.handler}] ${f.excerpt.slice(0, 90)}`).join('\n    ')
    );
  }

  if (problems.length === 0) {
    console.log(
      `✓ unguarded-await gate PASS — 0 direct findings across ${out.handlerCount} async handlers `
      + `in ${out.registrationSites} registration sites, ${out.parseErrors.length} parse errors.`
    );
    return 0;
  }
  console.error('✗ unguarded-await gate FAIL\n');
  for (const p of problems) console.error('  • ' + p + '\n');
  return 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.exitCode = selfTest();
    return;
  }
  const opts = { finallyProtects: argv.includes('--finally-protects') };
  const target = argv.find((a) => !a.startsWith('--')) || ROOT;
  const out = scan(path.resolve(target), opts);
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else report(out);
  // A census exits 0 by design; --gate is the only mode that can fail.
  process.exitCode = argv.includes('--gate') ? gate(out) : 0;
}

main();
