'use strict';
/*
 * The GENERIC certificate renderer and the two endpoints built on it.
 *
 * ─── WHY THESE TESTS READ THE PDF'S OWN BYTES ──────────────────────────────
 *
 * "It emitted a %PDF- header and more than 1KB" is true of a renderer that
 * draws the border and nothing else, which is the exact regression a refactor
 * of this file would cause. So the page's content stream is inflated and its
 * text operators decoded, and the assertions are on the STRINGS that came out.
 * That is the positive control: delete any draw call and a test fails by name.
 *
 * Counting BT blocks is the second control, for the property that has no
 * textual evidence — a run that WRAPPED instead of shrinking still contains
 * every character, and would pass a contains() check while colliding with the
 * line under it on the page. One text-showing block per run means one line per
 * run, whatever the name's length.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PassThrough } = require('stream');
const { installFakePool } = require('./helpers/fake-pool');
const { readMigration } = require('./helpers/migration-file');

const ROOT = path.join(__dirname, '..');

const fake = installFakePool([[/./, []]]);
after(() => fake.restore());

const {
  renderCertificatePdf, renderCertificateImage, planCertificate, certificateSvg,
  formatDate, OUTPUT_FORMATS, ARTWORK_PNG, ARTWORK_SVG, ARTWORK_LAYOUT, ARTWORK_DIR,
  DEFAULT_LAYOUT, PX_W, PX_H,
} = require('../utils/pdf-certificate');
const logger = require('../logger');

/* ── reading a pdfkit page back ───────────────────────────────────────────── */

function renderToBuffer(payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', (c) => chunks.push(c));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    renderCertificatePdf({ ...payload, stream: sink });
  });
}

/* Every FlateDecode stream in the file, inflated. The page content is one of them. */
function inflatedStreams(buf) {
  const out = [];
  let i = 0;
  while ((i = buf.indexOf('stream', i)) !== -1) {
    let start = i + 'stream'.length;
    if (buf[start] === 0x0d) start += 1;
    if (buf[start] === 0x0a) start += 1;
    const end = buf.indexOf('endstream', start);
    if (end === -1) break;
    /*
     * CONTENT streams only. Every stream used to be inflated and the image ones
     * merely threw, which was free while the certificate drew its own border —
     * then the Brand Kit artwork was vendored and the page began embedding a
     * 3508x2480 PNG. That XObject inflates cleanly to several megabytes of
     * pixel bytes, and running pdfText's global regex across it overflowed the
     * stack: every text assertion in this file died with
     * "Maximum call stack size exceeded" and nothing about the message pointed
     * at an image.
     *
     * The object's dictionary sits immediately before the keyword and says what
     * the stream is, so read it rather than guessing from the payload.
     */
    const dict = buf.subarray(Math.max(0, i - 512), i).toString('latin1');
    if (/\/Subtype\s*\/Image/.test(dict)) { i = end + 'endstream'.length; continue; }
    try { out.push(zlib.inflateSync(buf.subarray(start, end)).toString('latin1')); } catch { /* font */ }
    i = end + 'endstream'.length;
  }
  return out;
}

/*
 * pdfkit writes Helvetica text as hex inside a TJ array with kerning numbers
 * between the chunks — `[<45617379> 30 <466978> 0] TJ`. Concatenating the hex
 * chunks in order rebuilds the string; the kerning is layout, not content.
 */
function pdfText(buf) {
  const content = inflatedStreams(buf).join('\n');
  let text = '';
  for (const m of content.matchAll(/\[((?:\s*(?:<[0-9A-Fa-f]*>|-?[\d.]+))+)\s*\]\s*TJ/g)) {
    for (const hex of m[1].matchAll(/<([0-9A-Fa-f]*)>/g)) {
      text += Buffer.from(hex[1], 'hex').toString('latin1');
    }
    text += '\n';
  }
  for (const m of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) text += `${m[1]}\n`;
  return text;
}

/* One BT…ET per text() call, so this counts LINES actually drawn. */
function textBlocks(buf) {
  return (inflatedStreams(buf).join('\n').match(/(^|\n)BT(\n|$)/g) || []).length;
}

const FULL = {
  recipientName: 'Ramesh Kumar',
  title: 'Induction & Safety',
  dateText: '30 August 2026',
  certificateId: 'EF-TR-2026-0042',
  signatoryName: 'J. Ranjan',
  signatoryTitle: 'Training Head',
};

/* ── the generic contract ─────────────────────────────────────────────────── */

test('POSITIVE CONTROL: every run the payload asked for is actually on the page', async () => {
  /*
   * If the renderer is ever reduced to "draw the frame and end the document",
   * this is the test that says so. A %PDF- header check would not.
   */
  const text = pdfText(await renderToBuffer(FULL));
  for (const s of ['Ramesh Kumar', 'Induction & Safety', '30 August 2026',
    'EF-TR-2026-0042', 'J. Ranjan', 'Training Head', 'PRESENTED TO', 'DATE']) {
    assert.ok(text.includes(s), `the page must print ${JSON.stringify(s)}`);
  }
});

test('recipientName, title and stream are the only required inputs', async () => {
  const buf = await renderToBuffer({ recipientName: 'A B', title: 'Reading Only' });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(buf);
  assert.ok(text.includes('A B'));
  assert.ok(text.includes('Reading Only'));
});

test('the renderer knows nothing about technicians, courses or scores', () => {
  /*
   * The whole point of the rewrite. A domain word creeping back in is how the
   * one piece of company artwork becomes usable by one feature again.
   */
  const src = fs.readFileSync(path.join(ROOT, 'utils/pdf-certificate.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['technician', 'efr_name', 'efr_no', 'course', 'score', 'easyfixer']) {
    assert.doesNotMatch(code, new RegExp(word, 'i'),
      `${word} is a caller's concern — see lms.service::certificatePayload`);
  }
});

test('the defaults are applied when heading and eyebrow are omitted', async () => {
  const text = pdfText(await renderToBuffer({ recipientName: 'A B', title: 'T' }));
  assert.ok(text.includes('CERTIFICATE OF COMPLETION'), 'default heading');
  assert.ok(text.includes('FOR SUCCESSFULLY COMPLETING THE TRAINING'), 'default eyebrow');
});

test('a supplied heading and eyebrow REPLACE the defaults', async () => {
  const text = pdfText(await renderToBuffer({
    recipientName: 'A B', title: 'T', heading: 'CERTIFICATE OF APPRECIATION', eyebrow: 'FOR TEN YEARS',
  }));
  assert.ok(text.includes('CERTIFICATE OF APPRECIATION'));
  assert.ok(text.includes('FOR TEN YEARS'));
  assert.ok(!text.includes('CERTIFICATE OF COMPLETION'), 'the default must not also be drawn');
});

test('an omitted dateText defaults to TODAY IN IST, not to the server clock', async () => {
  /*
   * The suite runs TZ=UTC and so do the containers. Between 18:30 and 24:00 UTC
   * it is already tomorrow in Kolkata, so a renderer using the local date would
   * print yesterday's date on a certificate issued during the Indian morning.
   * The expectation is derived INDEPENDENTLY here (Intl, Asia/Kolkata) rather
   * than by calling the same helper the renderer calls.
   */
  const ist = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const expected = formatDate(ist);
  assert.match(expected, /^\d{2} [A-Z][a-z]+ \d{4}$/, 'DD MMMM YYYY');
  const text = pdfText(await renderToBuffer({ recipientName: 'A B', title: 'T' }));
  assert.ok(text.includes(expected), `today in IST (${expected}) must be printed`);
});

/* ── omission: never a label with nothing under it ────────────────────────── */

test('no certificateId and no signatory means those lines are ABSENT', async () => {
  const text = pdfText(await renderToBuffer({ recipientName: 'A B', title: 'Reading Only' }));
  assert.ok(!text.includes('EF-TR'), 'no id was supplied, so no id line');
  assert.ok(!text.includes('Training Head'), 'no signatory was supplied');
  assert.ok(!text.includes('J. Ranjan'));
});

test('a signatoryTitle without a name is not printed on its own', async () => {
  /*
   * "Training Head" floating over a blank rule reads as a document somebody
   * forgot to sign — worse than one that never claimed a signatory.
   */
  const text = pdfText(await renderToBuffer({
    recipientName: 'A B', title: 'T', signatoryTitle: 'Training Head',
  }));
  assert.ok(!text.includes('Training Head'));
});

test('an explicitly empty dateText drops the DATE label with it', async () => {
  const text = pdfText(await renderToBuffer({ recipientName: 'A B', title: 'T', dateText: '' }));
  assert.ok(!/\bDATE\b/.test(text), 'an empty value must not leave its caption behind');
});

test('omitted lines are not drawn as blanks — the block count drops', async () => {
  const full = textBlocks(await renderToBuffer(FULL));
  const bare = textBlocks(await renderToBuffer({ recipientName: 'A B', title: 'T', dateText: '' }));
  assert.ok(bare < full, 'a bare payload must draw strictly fewer text blocks');
});

/* ── overflow: shrink, never reflow ───────────────────────────────────────── */

test('a very long name SHRINKS instead of wrapping into the line below it', async () => {
  const long = 'Venkataramanan Balasubramaniam Chandrasekharan Krishnamoorthy Iyer';
  const short = await renderToBuffer(FULL);
  const big = await renderToBuffer({ ...FULL, recipientName: long });
  assert.equal(textBlocks(big), textBlocks(short),
    'a wrapped name would add a second line and push the page layout down');
  assert.ok(pdfText(big).includes(long), 'and it must still be legible in full');
});

test('a long TITLE shrinks the same way', async () => {
  const long = 'Advanced Split Air-Conditioner Installation, Servicing and Gas Charging Programme';
  const big = await renderToBuffer({ ...FULL, title: long });
  assert.equal(textBlocks(big), textBlocks(await renderToBuffer(FULL)));
  assert.ok(pdfText(big).includes(long));
});

/* ── the artwork, and its absence ─────────────────────────────────────────── */

test('the artwork contract with the design pipeline is pinned by filename', () => {
  /*
   * The frame and its layout are produced OUTSIDE this repo. A rename on either
   * side silently reverts every certificate to the plain fallback, and nothing
   * else in the suite would notice — the render still succeeds.
   */
  assert.equal(path.basename(ARTWORK_DIR), 'certificate');
  assert.equal(path.basename(path.dirname(ARTWORK_DIR)), 'assets');
  assert.equal(path.basename(ARTWORK_PNG), 'easyfix-certificate-frame-3508.png');
  assert.equal(path.basename(ARTWORK_LAYOUT), 'certificate-layout.json');
});

test('every region the layout file may name has a fallback rectangle', () => {
  /*
   * The fallback is not a different renderer, it is a different set of
   * rectangles — so a region present in the artwork layout but missing from
   * DEFAULT_LAYOUT would render fine WITH the art and vanish without it.
   */
  const expected = ['heading', 'eyebrowPresentedTo', 'recipientName', 'eyebrowFor', 'title',
    'dateLabel', 'dateValue', 'signatoryName', 'signatoryTitle', 'certificateIdLine'];
  assert.deepEqual(Object.keys(DEFAULT_LAYOUT).sort(), [...expected].sort());
  for (const [name, r] of Object.entries(DEFAULT_LAYOUT)) {
    for (const k of ['x', 'y', 'w', 'h']) {
      assert.ok(r[k] >= 0 && r[k] <= 1, `${name}.${k} must be normalised 0..1`);
    }
    assert.ok(r.x + r.w <= 1.0001, `${name} runs off the right edge`);
    assert.ok(r.y + r.h <= 1.0001, `${name} runs off the bottom edge`);
  }
});

test('missing artwork WARNS and still produces a complete certificate', async () => {
  /*
   * The art and this code ship on different clocks. A download that 500s
   * because a PNG has not landed is worse than one that looks plain, so the
   * absence is a warning and a fallback — never an error.
   *
   * Both states are asserted rather than one being skipped: when the frame does
   * land, the ARTWORK branch is what this test then guards, and either way the
   * page must still carry every run.
   */
  const present = fs.existsSync(ARTWORK_PNG) && fs.existsSync(ARTWORK_LAYOUT);
  const warnings = [];
  const original = logger.warn;
  logger.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  let buf;
  try { buf = await renderToBuffer(FULL); } finally { logger.warn = original; }

  const text = pdfText(buf);
  assert.ok(text.includes('Ramesh Kumar') && text.includes('EF-TR-2026-0042'),
    'the certificate must be complete in either state');

  if (present) {
    assert.equal(warnings.filter((w) => /artwork missing/.test(w)).length, 0,
      'the artwork is on disk, so nothing should warn about it');
  } else {
    const w = warnings.find((x) => /artwork missing/.test(x));
    assert.ok(w, 'a missing frame must be logged, not swallowed');
    assert.ok(w.includes(ARTWORK_DIR),
      'the warning must name the directory the files are expected in');
  }
});

test('a broken layout file falls back rather than half-placing the document', () => {
  /*
   * Read as source rather than executed, because the only way to execute it is
   * to write files into assets/certificate/ — which is exactly where the design
   * pipeline drops the real ones, and a test that races that would clobber them.
   */
  const src = fs.readFileSync(path.join(ROOT, 'utils/pdf-certificate.js'), 'utf8');
  const i = src.indexOf('function loadArtwork');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.match(body, /catch/, 'unparseable JSON must not reach the caller');
  assert.match(body, /recipientName\s*\|\|\s*!.*\.regions\.title|regions\.recipientName/,
    'a layout with no name/title rectangle is unusable and must fall back whole');
  assert.match(body, /return null/);
});

/* ── the date spelling ────────────────────────────────────────────────────── */

test('an IST datetime string is printed verbatim, never re-zoned', () => {
  assert.equal(formatDate('2026-08-30 14:22:10'), '30 August 2026');
  assert.equal(formatDate('2026-01-01 00:15:00'), '01 January 2026',
    'a just-past-midnight IST stamp must not slide to the previous day');
  assert.equal(formatDate(null), '—');
  assert.equal(formatDate('not a date'), '—');
});

/* ── POST /api/admin/certificates/render ──────────────────────────────────── */

const certRouter = require('../routes/admin/certificates');

function layerFor(router, method, p) {
  return router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
}

function responseDouble() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  return res;
}

/*
 * The gate moved from isLmsManage when the page did: this endpoint now backs an
 * HRMS screen, and a key that ties an HRMS page to an LMS permission reads as a
 * mistake in Manage Roles. The key is seeded by
 * migrations/2026-09-07-hrms-certificates-menu.sql, so the spelling is asserted
 * against that FILE and not against a string repeated here — a typo on either
 * side is a 403 nobody can grant their way out of.
 */
test('POST /render demands isCertificateIssue, the key the migration seeds', async () => {
  const layer = layerFor(certRouter, 'post', '/render');
  assert.ok(layer, 'the manual render endpoint must exist');
  const guard = layer.route.stack.find((h) => h.name === 'actionGuard');
  assert.ok(guard, 'printing on company letterhead is an authoring action');
  const res = responseDouble();
  await guard.handle(
    { user: { user_id: 1, permissions: { actionPermissions: [] } } },
    res,
    () => { throw new Error('guard passed a user with no grants'); },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(String(res.body.error), 'Missing permission: isCertificateIssue');
  assert.ok(!/isLmsManage/.test(String(res.body.error)),
    'the LMS key was retired here when the list page was');

  /* readMigration, not a hand-rolled path: the file moves to executed/ the day
   * it is applied, and pinning either directory is a red build on a pure move. */
  const sql = readMigration('2026-09-07-hrms-certificates-menu.sql');
  assert.match(sql, /'isCertificateIssue'/, 'the guard must name a key that is actually seeded');
});

test('a user WITH the grant passes the gate — the 403 is the key, not the guard', async () => {
  const layer = layerFor(certRouter, 'post', '/render');
  const guard = layer.route.stack.find((h) => h.name === 'actionGuard');
  let passed = false;
  await guard.handle(
    { user: { user_id: 1, permissions: { actionPermissions: ['isCertificateIssue'] } } },
    responseDouble(),
    () => { passed = true; },
  );
  assert.equal(passed, true, 'a guard that denies everyone would pass the test above too');
});

test('EVERY route on the certificates router is gated', () => {
  const routes = certRouter.stack.filter((l) => l.route);
  assert.equal(routes.length, 1, 'a new route was added without a permission assertion here');
  for (const l of routes) {
    assert.ok(l.route.stack.find((h) => h.name === 'actionGuard'), `${l.route.path} is ungated`);
  }
});

test('the manual render validates the generic payload, with the stated limits', () => {
  const layer = layerFor(certRouter, 'post', '/render');
  const v = layer.route.stack.map((h) => h.handle).find((h) => h._openapi);
  assert.ok(v, 'the body must go through validate()');
  assert.equal(v._openapi.source, 'body');
  const { schema } = v._openapi;

  assert.ok(schema.validate({ title: 'T' }).error, 'recipientName is required');
  assert.ok(schema.validate({ recipientName: 'A' }).error, 'title is required');
  assert.ok(!schema.validate({ recipientName: 'A', title: 'T' }).error, 'nothing else is');
  assert.ok(schema.validate({ recipientName: 'x'.repeat(121), title: 'T' }).error, 'name max 120');
  assert.ok(!schema.validate({ recipientName: 'x'.repeat(120), title: 'T' }).error);
  assert.ok(schema.validate({ recipientName: 'A', title: 'x'.repeat(161) }).error, 'title max 160');
  assert.ok(!schema.validate({ recipientName: 'A', title: 'x'.repeat(160) }).error);
  assert.ok(schema.validate({ recipientName: 'A', title: 'T', certificateId: 'x'.repeat(41) }).error,
    'certificateId max 40');
  assert.ok(!schema.validate({ recipientName: 'A', title: 'T', dateText: '' }).error,
    "'' is how a caller suppresses the date pair, so it must validate");

  /*
   * An OMITTED dateText must stay undefined through validation. Joi filling in a
   * default of '' here would silently mean "print no date", which is a
   * different document from "print today".
   */
  const { value } = schema.validate({ recipientName: 'A', title: 'T' });
  assert.equal('dateText' in value, false);
});

test('the manual render streams the document, attached and uncached', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/admin/certificates.js'), 'utf8');
  assert.match(src, /out\.contentType/,
    'the type comes from OUTPUT_FORMATS, so it cannot disagree with the extension');
  assert.match(src, /Content-Disposition[\s\S]*attachment/);
  assert.match(src, /no-store/, 'a named individual should not sit in a shared cache');
  /*
   * Comments stripped first. The header EXPLAINS why this route does not use
   * modernOk(), so a naive source scan reads its own rationale as a violation.
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /modernOk/, 'the body is the document, not an envelope');
  /* Purely a render: nothing may be written anywhere. */
  assert.doesNotMatch(code, /INSERT|UPDATE|pool\.query|s3\./i,
    'a certificate is a projection — there is no row and no file to own');
});

test('the manual render is mounted under /api/admin/certificates', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/admin/index.js'), 'utf8');
  assert.match(src, /router\.use\('\/certificates',\s*require\('\.\/certificates'\)\)/);
});

/* ── the format switch ────────────────────────────────────────────────────── */

test('format is pdf | png | jpg, defaulting to pdf', () => {
  const layer = layerFor(certRouter, 'post', '/render');
  const { schema } = layer.route.stack.map((h) => h.handle).find((h) => h._openapi)._openapi;
  const base = { recipientName: 'A', title: 'T' };

  assert.equal(schema.validate(base).value.format, 'pdf',
    'every caller that predates the switch must keep getting a PDF');
  for (const f of ['pdf', 'png', 'jpg']) {
    assert.equal(schema.validate({ ...base, format: f }).value.format, f);
  }
  assert.equal(schema.validate({ ...base, format: 'PNG' }).value.format, 'png', 'lowercased');
  for (const bad of ['jpeg', 'webp', 'tiff', 'svg', '']) {
    assert.ok(schema.validate({ ...base, format: bad }).error,
      `${JSON.stringify(bad)} is not an offered format`);
  }
});

test('each format has ONE content type and a matching extension', () => {
  assert.deepEqual(Object.keys(OUTPUT_FORMATS), ['pdf', 'png', 'jpg']);
  assert.deepEqual(OUTPUT_FORMATS.pdf, { contentType: 'application/pdf', ext: 'pdf' });
  assert.deepEqual(OUTPUT_FORMATS.png, { contentType: 'image/png', ext: 'png' });
  assert.deepEqual(OUTPUT_FORMATS.jpg, { contentType: 'image/jpeg', ext: 'jpg' },
    'jpg is the extension, image/jpeg is the type — they deliberately differ');
});

/*
 * The handler itself, not a source scan: a Content-Type that agrees with the
 * extension but not with the BYTES is the failure worth catching, and only
 * running it produces bytes.
 */
function handlerFor(router, method, p) {
  const layer = layerFor(router, method, p);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function bufferingResponse() {
  const res = { headers: {}, body: null, statusCode: 200 };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.write = (c) => { res.chunks.push(Buffer.from(c)); return true; };
  res.chunks = [];
  res.on = () => res;
  res.once = () => res;
  res.emit = () => false;
  res.end = (c) => { if (c) res.chunks.push(Buffer.from(c)); res.body = Buffer.concat(res.chunks); return res; };
  return res;
}

const MAGIC = {
  pdf: (b) => b.subarray(0, 5).toString() === '%PDF-',
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};

for (const format of ['pdf', 'png', 'jpg']) {
  test(`POST /render?format=${format} answers with the declared type AND those bytes`, async () => {
    const res = bufferingResponse();
    const handler = handlerFor(certRouter, 'post', '/render');
    await handler({ user: { user_id: 7 }, body: { ...FULL, format } }, res,
      (e) => { throw e || new Error('next() called'); });

    const spec = OUTPUT_FORMATS[format];
    assert.equal(res.headers['content-type'], spec.contentType);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-disposition'],
      new RegExp(`attachment; filename="EasyFix-Certificate-Ramesh-Kumar\\.${spec.ext}"$`),
      'the extension must name what was actually produced');

    /* The PDF is streamed, so it lands after doc.end() flushes. */
    const bytes = await new Promise((r) => setTimeout(() => r(Buffer.concat(res.chunks)), 60));
    assert.ok(bytes.length > 1000, `${format} produced ${bytes.length} bytes`);
    assert.ok(MAGIC[format](bytes),
      `the body must actually be ${format}, not just be labelled it`);
  });
}

test('png and jpg come back at the artwork native size, jpg opaque', async () => {
  const sharp = require('sharp');
  for (const format of ['png', 'jpg']) {
    const meta = await sharp(await renderCertificateImage({ ...FULL, format })).metadata();
    assert.equal(meta.width, PX_W);
    assert.equal(meta.height, PX_H);
    assert.equal(meta.format, format === 'jpg' ? 'jpeg' : 'png');
  }
  /*
   * A transparent ground encodes to BLACK in JPEG, not white — measured — so
   * this proves `flatten` ran.
   *
   * It samples the CENTRE, not the top-left corner. The corner test held only
   * while the certificate drew its own inset border on a white page; the
   * vendored Brand Kit artwork puts a solid red band (#C42430) hard against
   * every edge, so the corner is legitimately 196,36,48 and the old assertion
   * failed on correct output. The centre is the white field in both, and
   * asserting NOT-BLACK as well as light keeps the check pointed at the defect
   * it exists for rather than at a particular design.
   */
  const jpg = await sharp(await renderCertificateImage({ ...FULL, format: 'jpg' }))
    .raw().toBuffer({ resolveWithObject: true });
  assert.equal(jpg.info.channels, 3, 'JPEG carries no alpha');
  const mid = ((jpg.info.height >> 1) * jpg.info.width + (jpg.info.width >> 1)) * 3;
  const [r, g, b] = [jpg.data[mid], jpg.data[mid + 1], jpg.data[mid + 2]];
  assert.ok(r > 200 && g > 200 && b > 200,
    `the centre is ${r},${g},${b} — a flattened ground should be light, and black means alpha was dropped unflattened`);

  const png = await sharp(await renderCertificateImage({ ...FULL, format: 'png' }))
    .raw().toBuffer({ resolveWithObject: true });
  if (png.info.channels === 4) {
    let min = 255;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] < min) min = png.data[i];
    assert.equal(min, 255, 'the PNG must be opaque everywhere, not merely mostly');
  }
});

test('an image render defaults to png, so a caller who forgets is never surprised', async () => {
  const buf = await renderCertificateImage(FULL);
  assert.ok(MAGIC.png(buf));
});

/* ── ONE fitting decision, two outputs ────────────────────────────────────── */

/*
 * The property that has no visual evidence until it is already wrong: PDF and
 * image must place text from the same rectangles under the same shrink rule.
 * Two copies of that rule would each look right on their own page and disagree
 * the first time either was tweaked, so what is asserted here is that there IS
 * only one copy — and that it is scale-invariant, which is the whole reason one
 * copy can serve a 841.89pt page and a 3508px canvas.
 */
test('planCertificate is the ONLY thing that measures text', () => {
  const src = fs.readFileSync(path.join(ROOT, 'utils/pdf-certificate.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hits = code.match(/widthOfString|currentLineHeight/g) || [];
  assert.equal(hits.length, 2,
    'measurement belongs to fitRun alone — a second measurer is a second layout');
  const fit = code.slice(code.indexOf('function fitRun'), code.indexOf('const isBlank'));
  assert.match(fit, /widthOfString/);
  assert.match(fit, /currentLineHeight/);
});

test('the plan is scale-invariant, which is why one rule can serve both outputs', () => {
  const pdf = planCertificate(FULL, 841.89, 595.28, [ARTWORK_PNG]);
  const img = planCertificate(FULL, PX_W, PX_H, [ARTWORK_SVG, ARTWORK_PNG]);
  /*
   * TWO factors, not one. A4 landscape is 1.41428:1 and the 300dpi canvas is
   * 1.41452:1, so horizontal and vertical do not scale by quite the same
   * number. Point sizes follow the horizontal one, because that is the axis the
   * shrink loop measures against. Asserting a single factor here fails by 0.05
   * of a point and says nothing true.
   */
  const kx = PX_W / 841.89;
  const ky = PX_H / 595.28;

  assert.equal(img.runs.length, pdf.runs.length, 'the same runs are drawn at both sizes');
  for (let i = 0; i < pdf.runs.length; i++) {
    const a = pdf.runs[i];
    const b = img.runs[i];
    assert.equal(b.name, a.name);
    assert.equal(b.text, a.text, `${a.name} must not shrink to a different STRING at 300dpi`);
    /*
     * Tolerance is one QUANTISATION STEP, not a hair.
     *
     * The shrink loop walks a half-unit grid, so each plan rounds to its own
     * grid at its own scale and `a.size * kx` lands between b's grid points.
     * Demanding 0.01 asserts exact proportionality, which the algorithm never
     * promised: with the real layout rectangles vendored in, recipientName
     * came out 128.96 against an expected 128.98 and failed on correct output.
     *
     * Half a step is the largest a rounding difference can be; a genuinely
     * different DECISION differs by whole points, so this still fails loudly
     * for the thing the test is for. The strings are compared exactly above,
     * which is the assertion that catches a divergent decision outright.
     */
    const STEP = 0.5;
    const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol,
      `${a.name}.${what}: ${got} is not ${want} (tolerance ${tol})`);
    near(b.size, a.size * kx, STEP, 'size');
    near(b.tracking, a.tracking * kx, STEP, 'tracking');
    near(b.rect.x, a.rect.x * kx, 0.01, 'rect.x');
    near(b.rect.w, a.rect.w * kx, 0.01, 'rect.w');
    near(b.rect.y, a.rect.y * ky, 0.01, 'rect.y');
    near(b.rect.h, a.rect.h * ky, 0.01, 'rect.h');
    /* top/baseline mix a ky-scaled rectangle with a kx-scaled line height. */
    near(b.top, a.top * ky, 0.6, 'top');
    near(b.baseline, a.baseline * ky, 0.6, 'baseline');
  }
});

test('a name that FITS is never given an ellipsis it did not need', () => {
  /*
   * REGRESSION, found by looking at a render rather than by a green suite. The
   * truncation loop measures `text + '…'`, which is wider than `text`, so
   * without a guard it shaved a character off a 66-character name the shrink
   * step had already made fit. Both outputs truncated it identically — sharing
   * the rule is not the same as the rule being right.
   */
  const long = 'Venkataramanan Balasubramaniam Chandrasekharan Krishnamoorthy Iyer';
  const plan = planCertificate({ ...FULL, recipientName: long }, PX_W, PX_H, [ARTWORK_PNG]);
  const run = plan.runs.find((r) => r.name === 'recipientName');
  assert.equal(run.text, long, 'it shrank to fit, so nothing may be cut off it');
  assert.ok(run.rect.x + run.rect.w <= PX_W, 'and it stays inside the canvas');
});

test('what MIN_PT still cannot hold is truncated, in BOTH outputs identically', async () => {
  const wall = 'X'.repeat(400);
  const plan = planCertificate({ ...FULL, recipientName: wall }, PX_W, PX_H, [ARTWORK_PNG]);
  const run = plan.runs.find((r) => r.name === 'recipientName');
  assert.ok(run.text.length < wall.length, 'an unbreakable 400-character run must be cut');
  assert.ok(run.text.endsWith('…'), 'and the cut must be visible');
  assert.ok(certificateSvg(plan).includes(run.text.slice(0, 40)),
    'the SVG prints the plan\'s string, never its own truncation');

  const pdfText_ = pdfText(await renderToBuffer({ ...FULL, recipientName: wall }));
  assert.ok(pdfText_.includes(run.text.slice(0, 40)), 'and so does the PDF');
});

/* ── the SVG the raster is composed from ──────────────────────────────────── */

test('POSITIVE CONTROL: the SVG carries every run, not just a frame', () => {
  /*
   * The image sibling of the PDF's positive control. If certificateSvg is ever
   * reduced to an empty canvas the raster still encodes, still has the right
   * dimensions and still passes every metadata check above — this is the test
   * that notices.
   */
  const plan = planCertificate(FULL, PX_W, PX_H, [ARTWORK_PNG]);
  const svg = certificateSvg(plan);
  for (const s of ['Ramesh Kumar', 'Induction &amp; Safety', '30 August 2026',
    'EF-TR-2026-0042', 'J. Ranjan', 'Training Head', 'PRESENTED TO', 'DATE']) {
    assert.ok(svg.includes(s), `the overlay must carry ${JSON.stringify(s)}`);
  }
  assert.ok(svg.includes(`width="${PX_W}" height="${PX_H}"`),
    'sharp composites at the SVG\'s intrinsic size, so it must declare the canvas');
  /*
   * Counted against the PLAN, not against a literal: the fallback adds a
   * wordmark run that the artwork supplies itself, so a hardcoded number here
   * would flip the day the frame lands and prove nothing either way.
   */
  assert.equal((svg.match(/<text /g) || []).length, plan.runs.length,
    'one <text> per planned run — a dropped run is a missing line');
  assert.ok(plan.runs.length >= 10, `only ${plan.runs.length} runs were planned`);
});

test('the SVG escapes markup rather than emitting it', () => {
  const svg = certificateSvg(planCertificate(
    { ...FULL, recipientName: 'A & B', title: '<script>x</script>' }, PX_W, PX_H, [ARTWORK_PNG],
  ));
  assert.ok(svg.includes('A &amp; B'));
  assert.ok(!svg.includes('<script>'), 'an operator-typed name must not become an element');
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('omitted runs are absent from the SVG too, not drawn empty', () => {
  const svg = certificateSvg(planCertificate(
    { recipientName: 'A B', title: 'Reading Only', dateText: '' }, PX_W, PX_H, [ARTWORK_PNG],
  ));
  assert.ok(!svg.includes('EF-TR'), 'no id was supplied');
  assert.ok(!svg.includes('Training Head'));
  assert.ok(!/>DATE</.test(svg), 'an empty date drops its caption in both outputs');
});

test('the image path prefers the VECTOR frame and falls back to the same raster the PDF uses', () => {
  assert.equal(path.basename(ARTWORK_SVG), 'easyfix-certificate-frame.svg');
  const src = fs.readFileSync(path.join(ROOT, 'utils/pdf-certificate.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /planCertificate\(values, PX_W, PX_H, \[ARTWORK_SVG, ARTWORK_PNG\]\)/,
    'SVG first, then the raster — so a day when only one has landed still matches the PDF');
  assert.match(code, /planCertificate\(values, W, H, \[ARTWORK_PNG\]\)/,
    'pdfkit cannot read SVG, so the PDF must not be offered it');
});

test('missing artwork WARNS and still produces a complete IMAGE', async () => {
  const present = fs.existsSync(ARTWORK_SVG) || fs.existsSync(ARTWORK_PNG);
  const warnings = [];
  const original = logger.warn;
  logger.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  let buf;
  try { buf = await renderCertificateImage({ ...FULL, format: 'png' }); } finally {
    logger.warn = original;
  }
  assert.ok(MAGIC.png(buf) && buf.length > 1000,
    'a frame that has not landed must never be a 500');
  if (!present) {
    assert.ok(warnings.find((w) => /artwork missing/.test(w)),
      'the absence is logged on the image path too, not only the PDF one');
  }
});
