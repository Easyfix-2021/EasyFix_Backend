/*
 * Resolution branches for a stored tbl_job_image value.
 *
 * These assertions could not exist before 2026-09-10: the chain lived inline in
 * the /images/:imageId/file handler, so exercising it needed a request, a pool
 * and a scope guard. Extracting it to services/job-image-delivery.js is what
 * made the branches reachable — and the extraction happened because a SECOND
 * route (/url) now has to resolve identically.
 *
 * S3 is stubbed OFF so these cover the URL branches, which is where the
 * production bugs were: an unverified legacy redirect (ERR_BLOCKED_BY_ORB) and
 * the open-redirect guard.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Stub S3 BEFORE the module under test requires it, so no AWS client is built
// and the S3 branch is skipped deterministically.
const s3Path = require.resolve(path.join(ROOT, 'utils/s3-storage.js'));
require.cache[s3Path] = {
  id: s3Path, filename: s3Path, loaded: true,
  exports: { isEnabled: () => false, exists: async () => false, getPresignedUrl: async () => 'unused' },
};

const delivery = require(path.join(ROOT, 'services/job-image-delivery.js'));

// Deterministic fetch stub — the real HEAD is a network call.
const realFetch = global.fetch;
function stubFetch(impl) { global.fetch = impl; }
test.after(() => { global.fetch = realFetch; });

const HTML_404 = () => Promise.resolve({ ok: false, status: 404, headers: new Map([['content-type', 'text/html; charset=iso-8859-1']]) });
const IMAGE_200 = () => Promise.resolve({ ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]) });
// `new Map()` has .get, which is all legacyUrlHasImage uses.

test('an allowlisted legacy URL whose file EXISTS is served', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch(IMAGE_200);
  const r = await delivery.resolve('http://core.easyfix.in/easydoc/upload_jobs/538390_checkin_x.jpg');
  assert.equal(r.kind, 'legacy');
  assert.ok(r.url.startsWith('https://'), 'must be https-upgraded — a browser blocks http images on an https page');
});

test('an allowlisted legacy URL whose file is MISSING is refused, not redirected', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch(HTML_404);
  const r = await delivery.resolve('http://core.easyfix.in/easydoc/upload_jobs/530707_gone.jpg');
  assert.equal(r.kind, 'none', 'redirecting here hands the browser an HTML error page — ORB blocks it and the operator sees no reason');
  assert.match(r.reason, /legacy host has no image/);
});

test('a HEAD that FAILS is not evidence of absence — still served', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch(() => Promise.reject(Object.assign(new Error('boom'), { name: 'TimeoutError' })));
  const r = await delivery.resolve('http://core.easyfix.in/easydoc/upload_jobs/x.jpg');
  assert.equal(r.kind, 'legacy', 'a network fault must not hide a file that is really there');
});

test('an absolute URL on a NON-allowlisted host is never redirected to', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  let called = false;
  stubFetch(() => { called = true; return IMAGE_200(); });
  const r = await delivery.resolve('https://evil.example.com/steal.jpg');
  assert.equal(r.kind, 'none', 'this value comes from a DB column — redirecting anywhere is an open redirect');
  assert.equal(called, false, 'must not even contact a non-allowlisted host');
});

test('an absolute FILE_BASE_URL is used for a bare filename', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  process.env.FILE_BASE_URL = 'https://files.example.com/easydoc';
  const r = await delivery.resolve('somefile.jpg');
  assert.equal(r.kind, 'base-url');
  assert.equal(r.url, 'https://files.example.com/easydoc/upload_jobs/somefile.jpg');
  delete process.env.FILE_BASE_URL;
});

test('a RELATIVE FILE_BASE_URL is not used — it would bounce back to this backend', async () => {
  process.env.FILE_BASE_URL = '/easydoc';
  const r = await delivery.resolve('somefile.jpg');
  assert.equal(r.kind, 'none');
  delete process.env.FILE_BASE_URL;
});

test('an empty stored value resolves to nothing', async () => {
  const r = await delivery.resolve('   ');
  assert.equal(r.kind, 'none');
});

test('positive control: the resolver CAN return legacy, so the refusals above are real', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch(IMAGE_200);
  const r = await delivery.resolve('https://core.easyfix.in/easydoc/upload_jobs/ok.jpg');
  assert.equal(r.kind, 'legacy', 'if this failed, every assertion above would pass for the wrong reason');
});
