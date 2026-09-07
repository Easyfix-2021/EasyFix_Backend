const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  verifyIdempotencyUpload,
  deterministicUploadToken,
} = require('../middleware/verify-idempotency-upload');

function response() {
  const sent = [];
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { sent.push({ status: this.statusCode, body }); return this; },
  };
  return { res, sent };
}

function request(buffer, digest) {
  return {
    method: 'POST',
    originalUrl: '/api/mobile/uploads',
    headers: {
      'idempotency-key': 'identity-42.front',
      'idempotency-content-digest': digest,
    },
    tech: { efr_id: 8379 },
    file: { buffer },
  };
}

test('server verifies the app digest against uploaded bytes before storage', () => {
  const buffer = Buffer.from('bounded identity image');
  const digest = crypto.createHash('md5').update(buffer).digest('hex');
  const req = request(buffer, digest.toUpperCase());
  const { res, sent } = response();
  let proceeded = false;

  verifyIdempotencyUpload(req, res, () => { proceeded = true; });
  assert.equal(proceeded, true);
  assert.equal(sent.length, 0);
  assert.equal(req.idempotencyContentDigestVerified, true);
});

test('digest mismatch is rejected before object storage', () => {
  const req = request(Buffer.from('actual bytes'), '00000000000000000000000000000000');
  const { res, sent } = response();
  let proceeded = false;

  verifyIdempotencyUpload(req, res, () => { proceeded = true; });
  assert.equal(proceeded, false);
  assert.equal(sent[0].status, 400);
  assert.equal(sent[0].body.details.code, 'IDEMPOTENCY_CONTENT_DIGEST_MISMATCH');
});

test('stable actor endpoint key and digest derive the same crash-replay object token', () => {
  const buffer = Buffer.from('same identity image');
  const digest = crypto.createHash('md5').update(buffer).digest('hex');
  const first = request(buffer, digest);
  const replay = request(buffer, digest);
  first.idempotencyContentDigestVerified = true;
  replay.idempotencyContentDigestVerified = true;

  const firstToken = deterministicUploadToken(first);
  assert.equal(deterministicUploadToken(replay), firstToken);
  replay.headers['idempotency-key'] = 'identity-42.back';
  assert.notEqual(deterministicUploadToken(replay), firstToken);
});

/*
 * ─── The keyed-upload route set is DISCOVERED, never listed ─────────────────
 *
 * CONTRACT (what the loop below iterates): every multipart handler reachable
 *   under a router that installs the idempotency ledger. It is derived from the
 *   source of truth in two hops — walk routes/ for the `router.use(idempotency)`
 *   mount, then walk that mount's own directory for every route file it serves.
 * RECORD (what the loop used to iterate): three hard-coded filenames, each with
 *   a hand-written count of adjacent `multer , verify` pairs.
 *
 * Iterating the record could only answer "are the three uploads somebody wrote
 * down still guarded". It was blind in both of the ordinary directions. A NEW
 * keyed route file was never opened at all. And a SECOND handler added inside a
 * file it did name contributed zero matches to a count-of-verified-pairs, so the
 * recorded number still agreed and the unguarded handler was invisible. Both
 * failures presented as a green test, which is the worst shape a gate can take.
 *
 * The count is gone with it: a number that has to be hand-updated is the same
 * defect wearing a different hat. The PASS line reports the discovered total, so
 * a set that shrinks to nothing is visible in the output rather than silent.
 */

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

// `router.use(require('../../middleware/idempotency')())` — the mount that makes
// every route below it replayable, and therefore keyed. Its directory stands in
// for "the routes it serves", which holds because every keyed router mounts its
// own siblings. A keyed router that mounted a route file from another directory
// would fall outside the walk; that would need the mount graph, not a tree walk.
const IDEMPOTENCY_MOUNT = /router\.use\(\s*require\(['"][^'"]*middleware\/idempotency['"]\)\s*\(/;

const MULTIPART_METHODS = 'single|array|fields|any';

function jsFilesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFilesUnder(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/*
 * Every identifier in one file that ends up parsing a multipart body: the Multer
 * instances themselves, the handlers built from them (`const aadhaarUpload =
 * upload.fields([...])`), and the wrappers that call one (`aadhaarUploadOr400`).
 * Two widening passes cover that three-link chain — the deepest this repo goes.
 * A fourth link would need a real parser, and would be worth one.
 */
function multipartCarriers(source) {
  const carriers = new Set(
    [...source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*multer\s*\(/g)].map((m) => m[1]),
  );
  const derived = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*(\\w+)\\s*\\.(?:${MULTIPART_METHODS})\\s*\\(`, 'g');
  const declared = /function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [, name, base] of source.matchAll(derived)) {
      if (carriers.has(base)) carriers.add(name);
    }
    for (const [, name, body] of source.matchAll(declared)) {
      if ([...carriers].some((c) => new RegExp(`\\b${c}\\s*\\(`).test(body))) carriers.add(name);
    }
  }
  return carriers;
}

/*
 * The middleware chain of each route registration: everything between
 * `router.post(` and the request handler's own `(req, res` parameter list,
 * bounded by the next registration so a route whose handler is a named
 * reference cannot swallow its neighbour.
 */
function routeChains(source) {
  const starts = [...source.matchAll(/\brouter\.(?:post|put|patch|delete|all)\s*\(/g)].map((m) => m.index);
  return starts.map((from, i) => {
    const stop = i + 1 < starts.length ? starts[i + 1] : source.length;
    const region = source.slice(from, stop);
    const handler = region.search(/\(\s*req\s*,\s*res/);
    return region.slice(0, handler === -1 ? region.length : handler);
  });
}

/*
 * Refusing the Idempotency-Key outright is the OTHER compliant shape, and the
 * only honest one for a multi-file route: verifyIdempotencyUpload binds a single
 * digest to `req.file`, which `.fields()` never populates. Refusers are found by
 * the error code they answer with, so this stays derived from source rather than
 * becoming a second hand-written list of blessed middleware names.
 */
function keyRefusers(source) {
  return new Set(
    [...source.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g)]
      .filter(([, , body]) => body.includes('IDEMPOTENCY_NOT_SUPPORTED'))
      .map(([, name]) => name),
  );
}

test('every keyed multipart route in the routes tree guards its uploaded bytes', () => {
  const keyedDirs = [...new Set(
    jsFilesUnder(ROUTES_DIR)
      .filter((file) => IDEMPOTENCY_MOUNT.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.dirname(file)),
  )];
  assert.ok(keyedDirs.length > 0, 'no router mounts middleware/idempotency — discovery is broken');

  const multipart = [];
  const strayGuards = [];
  for (const file of keyedDirs.flatMap(jsFilesUnder)) {
    const source = fs.readFileSync(file, 'utf8');
    const carriers = multipartCarriers(source);
    const refusers = keyRefusers(source);
    const where = path.relative(path.join(__dirname, '..'), file);

    for (const chain of routeChains(source)) {
      const carrier = [...carriers].find((c) => new RegExp(`\\b${c}\\s*[.,()]`).test(chain));
      const verifies = chain.indexOf('verifyIdempotencyUpload');
      if (!carrier) {
        // Reverse direction: a guard on a route that parses nothing. It cannot
        // find a `req.file` to hash, so it 400s every keyed request it sees.
        if (verifies !== -1) strayGuards.push(`${where} · ${chain.trim().split('\n')[0]}`);
        continue;
      }
      const route = `${where} · ${chain.trim().split('\n')[0]}`;
      const refuses = [...refusers].some((r) => new RegExp(`\\b${r}\\b`).test(chain));
      assert.ok(
        verifies !== -1 || refuses,
        `${route} parses a multipart body on a keyed router with neither verifyIdempotencyUpload nor a key refusal`,
      );
      if (verifies !== -1) {
        assert.ok(
          verifies > chain.search(new RegExp(`\\b${carrier}\\s*[.,()]`)),
          `${route} verifies before Multer parses — req.file is still empty there`,
        );
      }
      multipart.push(route);
    }
  }

  assert.deepEqual(strayGuards, [], 'verifyIdempotencyUpload guards a route that parses no file');
  assert.ok(multipart.length > 0, 'discovered no keyed multipart route — the scan, not the code, is at fault');
  console.log(`  ↳ ${multipart.length} keyed multipart routes discovered and guarded`);
});
