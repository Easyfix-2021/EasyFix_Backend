'use strict';
/*
 * Course-completion certificates and the derived badge.
 *
 * Two things are pinned here that are not obvious from reading the route:
 *
 *   1. certificateData answers FOUR separate "no certificate" cases with one
 *      query, and every one of them must 404 rather than render a blank but
 *      official-looking document.
 *   2. The route validates two path parameters. validate() runs Joi with
 *      stripUnknown and assigns the result back over req.params, so a
 *      one-key schema on a two-parameter route does not fail to check the
 *      second — it DELETES it. That was a live bug for the length of one
 *      edit, and nothing about the route reads wrong afterwards.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');
const ROW = {
  enrolment_id: 42,
  completion_date: '2026-08-30 14:22:10',
  score: 88,
  course_name: 'Induction & Safety',
  efr_name: 'Ramesh Kumar',
  efr_no: '9876543210',
};

const fake = installFakePool([[/./, []]]);
after(() => fake.restore());

const svc = require('../services/lms.service');
const { renderCertificatePdf, formatDate } = require('../utils/pdf-certificate');

test('no eligible row is a 404, never a blank certificate', async () => {
  fake.reset();
  await assert.rejects(() => svc.certificateData(3, 9), /no certificate available/);
});

test('entitlement is the STAMP, not the course\'s current settings', async () => {
  fake.reset();
  await svc.certificateData(3, 9).catch(() => {});
  const sql = fake.calls.map((c) => c.sql).find((s) => /enrolment_id/.test(s)) || '';
  assert.match(sql, /ec\.badge_earned_at IS NOT NULL/);
  assert.match(sql, /ec\.course_id = \?[\s\S]*ec\.easyfixer_id = \?/,
    'both the course and the technician must be named');
  /*
   * THE POINT OF THE CHANGE. Re-checking the course's live flags at download
   * time let an admin revoke a certificate somebody had already earned, just by
   * turning the toggle off or retiring the course.
   */
  assert.doesNotMatch(sql, /c\.certificate_enabled/,
    'a flag flip must not revoke an earned certificate');
  assert.doesNotMatch(sql, /c\.status = 1/,
    'retiring a course must not revoke certificates already earned from it');
});

test('it rides a STAMP, never a recomputation', async () => {
  fake.reset();
  await svc.certificateData(3, 9).catch(() => {});
  const sql = fake.calls.map((c) => c.sql).find((s) => /enrolment_id/.test(s)) || '';
  assert.doesNotMatch(sql, /lms_content|COUNT\(/,
    'recomputing completion would revoke a certificate the moment an admin '
    + 'added a video to the course next month');
});

test('an eligible row returns everything the document prints', async () => {
  const f2 = installFakePool([[/enrolment_id/i, [ROW]], [/./, []]]);
  try {
    const row = await svc.certificateData(3, 9);
    for (const k of ['completion_date', 'score', 'course_name', 'efr_name', 'efr_no']) {
      assert.ok(k in row, `${k} must be selected`);
    }
  } finally { f2.restore(); }
});

/*
 * UPDATED 2026-09-07 — renderCertificatePdf is now GENERIC.
 *
 * It used to take { technician, course, completedOn, score } and reach into
 * LMS-shaped objects, which made the one piece of company artwork usable by one
 * feature. It now takes nine strings and the LMS mapping lives in
 * certificatePayload() below, so these two tests exercise the mapping — the
 * part that can actually regress here — rather than restating the renderer's
 * own contract, which tests/certificate-render.test.js now pins in full.
 *
 * The SCORE is deliberately gone from the document. There is no field for it in
 * the generic payload: a percentage is assessment bookkeeping, and it was
 * already conditional (a null score printed nothing) so no certificate loses a
 * line it was guaranteed to have. It remains on the training report.
 */
test('the renderer emits a real PDF from the LMS payload', async () => {
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => sink.on('end', res));
  renderCertificatePdf({ ...svc.certificatePayload(ROW), stream: sink });
  await done;
  const buf = Buffer.concat(chunks);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-', 'must be a PDF');
  assert.ok(buf.length > 1000, 'a one-page certificate is ~2KB, not empty');
});

test('a course with no assessment still maps and renders', async () => {
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => sink.on('end', res));
  renderCertificatePdf({
    ...svc.certificatePayload({ ...ROW, score: null, efr_no: null, course_name: 'Reading Only' }),
    stream: sink,
  });
  await done;
  assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), '%PDF-',
    'a null score must not throw — the document simply has no score on it');
});

test('an IST datetime string is printed verbatim, never re-zoned', () => {
  /*
   * The pool runs with dateStrings, so completion_date arrives already in IST.
   * Parsing it into a Date and formatting locally is the shift that has bitten
   * this codebase repeatedly. The SPELLING changed with the new artwork
   * ('30 August 2026' rather than '30/08/2026'); the no-re-zoning property it
   * exists to protect did not.
   */
  assert.equal(formatDate('2026-08-30 14:22:10'), '30 August 2026');
  assert.equal(formatDate('2026-01-01 00:15:00'), '01 January 2026',
    'a just-past-midnight IST stamp must not slide to the previous day');
  assert.equal(formatDate(null), '—');
  assert.equal(formatDate('not a date'), '—');
});

/* ── The certificate number ───────────────────────────────────────────────── */

test('the certificate number is EF-TR-<completion year>-<4-digit enrolment id>', () => {
  assert.equal(
    svc.certificateNumber({ enrolment_id: 42, completion_date: '2026-08-30 09:00:00', badge_earned_at: '2026-08-31 09:00:00' }),
    'EF-TR-2026-0042',
  );
});

test('the number carries the year the training was COMPLETED, not the year it is printed', () => {
  /*
   * A technician downloading his 2024 certificate today must not get a 2026
   * number for the same document — the number is what an operator verifies over
   * the phone, so it has to be stable for the life of the certificate.
   */
  assert.equal(
    svc.certificateNumber({ enrolment_id: 7, badge_earned_at: '2024-02-01 10:00:00', completion_date: '2024-01-30 10:00:00' }),
    'EF-TR-2024-0007',
  );
  /* A row with no finish date falls back to the badge stamp. */
  assert.equal(
    svc.certificateNumber({ enrolment_id: 7, completion_date: null, badge_earned_at: '2023-11-02 10:00:00' }),
    'EF-TR-2023-0007',
  );
});

test('the number and the printed date can never disagree', () => {
  /*
   * THE regression, and the one no single-field assertion could see. Until
   * 2026-09-07 the number took its year from badge_earned_at while the date
   * came from completion_date. Each rule was individually defensible and each
   * had a passing test; the defect lived only in the PAIR.
   *
   * Reachable, not theoretical: stampBadges sets badge_earned_at = NOW() for
   * every completed enrolment once certificate_enabled is switched on, so
   * enabling that flag for an older course stamps last year's completions with
   * today's date. A certificate then read "31 December 2026" above the number
   * EF-TR-2027-0007.
   */
  const spans = [
    { completion_date: '2026-12-31 23:00:00', badge_earned_at: '2027-01-01 01:00:00' },
    { completion_date: '2024-01-01 00:30:00', badge_earned_at: '2026-06-01 00:00:00' },
    { completion_date: '2025-07-04 12:00:00', badge_earned_at: '2025-07-04 12:00:01' },
  ];
  for (const dates of spans) {
    const p = svc.certificatePayload({ ...ROW, ...dates });
    const numberYear = p.certificateId.split('-')[2];
    const printedYear = p.dateText.slice(-4);
    assert.equal(
      numberYear,
      printedYear,
      `number ${p.certificateId} contradicts the date it prints (${p.dateText})`,
    );
  }

  /*
   * Positive control: the assertion above is only meaningful if these rows
   * COULD have disagreed. The first span crosses a year boundary, so a
   * badge-derived year would read 2027 against a printed 2026.
   */
  assert.notEqual(
    String(spans[0].completion_date).slice(0, 4),
    String(spans[0].badge_earned_at).slice(0, 4),
    'the fixture must actually span two years, or this test proves nothing',
  );
});

test('four digits is a FLOOR — a large id is never truncated into someone else\'s number', () => {
  assert.equal(
    svc.certificateNumber({ enrolment_id: 198765, badge_earned_at: '2026-01-01 00:00:00' }),
    'EF-TR-2026-198765',
  );
});

test('the LMS payload maps the row onto the GENERIC renderer, signatory included', () => {
  const p = svc.certificatePayload({ ...ROW, badge_earned_at: '2026-08-31 09:00:00' });
  assert.equal(p.recipientName, 'Ramesh Kumar');
  assert.equal(p.title, 'Induction & Safety');
  assert.equal(p.dateText, '30 August 2026', 'the day the training was finished, not today');
  assert.equal(p.certificateId, 'EF-TR-2026-0042');
  assert.equal(p.signatoryName, 'J. Ranjan');
  assert.equal(p.signatoryTitle, 'Training Head');
  assert.equal('score' in p, false, 'the certificate carries no percentage');
});

test('BOTH download routes go through the ONE mapping', () => {
  /*
   * The CRM's download and the technician's own must print the same document
   * for the same enrolment. Two inline mappings is how they stop doing that.
   */
  for (const f of ['routes/admin/lms.js', 'routes/mobile/lms.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const i = src.indexOf('renderCertificatePdf({');
    assert.ok(i > 0, `${f} must render a certificate`);
    assert.match(src.slice(i, i + 120), /certificatePayload\(row\)/,
      `${f} must not build the payload itself`);
  }
});

test('REGRESSION: the certificate route validates BOTH path params', () => {
  /*
   * With validate(idParam) this route 400s on every request, because
   * stripUnknown removes easyfixerId from req.params before the handler runs.
   */
  const src = fs.readFileSync(path.join(ROOT, 'routes/admin/lms.js'), 'utf8');
  const line = src.split('\n').findIndex((l) => l.includes("/courses/:courseId/certificate/:easyfixerId"));
  assert.ok(line > 0, 'the route must use :courseId, matching assignmentParams');
  const near = src.split('\n').slice(line, line + 4).join('\n');
  assert.match(near, /validate\(assignmentParams, 'params'\)/);
  assert.doesNotMatch(near, /validate\(idParam/,
    'a one-key schema DELETES the second parameter rather than checking it');
});

test('the download is streamed, not JSON-wrapped, and not cached', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/admin/lms.js'), 'utf8');
  const i = src.indexOf("/courses/:courseId/certificate/:easyfixerId");
  const block = src.slice(i, i + 2200);
  assert.match(block, /application\/pdf/);
  assert.match(block, /Content-Disposition/);
  assert.match(block, /no-store/, 'a named individual should not sit in a shared cache');
  assert.match(block, /await svc\.certificateData[\s\S]*renderCertificatePdf/,
    'data must be fetched BEFORE piping — once the stream starts the status '
    + 'line is already sent and an error can no longer become a 404');
});

test('the training report ships the ONE field the CRM needs to HIDE the button', () => {
  /*
   * The download route is gated on three facts; the report row used to expose
   * only one of them, so the CRM could offer a certificate for a course that
   * does not issue one and the operator found out from an error toast. If this
   * projection ever loses these two columns the button silently starts 404ing
   * again, and nothing else in the suite would notice.
   */
  const src = fs.readFileSync(path.join(ROOT, 'services/lms.service.js'), 'utf8');
  const i = src.indexOf('async function trainingReport');
  assert.ok(i > 0, 'trainingReport must exist');
  const body = src.slice(i, i + 4000);
  assert.match(body, /ec\.badge_earned_at/,
    'the download gates on the earn stamp, so the button must too');
});

/* ── Durability: the property the stamp exists to guarantee ───────────────── */

test('the badge stamp only ever fills NULLs — an earn time is never rewritten', async () => {
  fake.reset();
  await svc.stampBadges({ efrIds: [9] });
  const sql = fake.calls.map((c) => c.sql).find((x) => /badge_earned_at = \?/.test(x)) || '';
  assert.match(sql, /ec\.badge_earned_at IS NULL/,
    're-settling a completed course must not move the date it was earned');
  assert.match(sql, /ec\.completion_date IS NOT NULL/, 'it must be finished');
  assert.match(sql, /c\.certificate_enabled = 1/,
    'the flag decides eligibility HERE, at earn time — and nowhere else');
});

test('the badge stamp refuses to run unscoped', async () => {
  fake.reset();
  const r = await svc.stampBadges({});
  assert.equal(r.stamped, 0);
  assert.equal(fake.calls.some((c) => /badge_earned_at = \?/.test(c.sql)), false,
    'an unscoped run would back-date badges platform-wide the first time an '
    + 'operator enables the flag on an old course');
});

test('the badge stamp narrows by course for the bulk path', async () => {
  fake.reset();
  await svc.stampBadges({ courseId: 3 });
  const sql = fake.calls.map((c) => c.sql).find((x) => /badge_earned_at = \?/.test(x)) || '';
  assert.match(sql, /ec\.course_id = \?/);
  assert.doesNotMatch(sql, /ec\.easyfixer_id IN/);
});

test("the technician's course list ships the stamp, never the course flag", () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/lms.service.js'), 'utf8');
  const i = src.indexOf('async function coursesForTech');
  /*
   * From the function, NOT from 2500 characters before it. The window used to
   * start upstream, and whatever function happened to sit there contributed its
   * own `FROM easyfixer_courses` AHEAD of this SELECT — so the slice below ran
   * backwards and produced an empty string, and the assertion passed on nothing
   * for as long as that neighbour existed. Deleting the neighbour is what
   * revealed it, not a change to the query.
   */
  const block = src.slice(i, i + 4000);
  assert.match(block, /ec\.badge_earned_at/);
  const sel = block.indexOf('SELECT ec.course_id');
  const projection = block.slice(sel, block.indexOf('FROM easyfixer_courses', sel))
    /* The comment EXPLAINS the omission by naming the column — see observation
     * about a migration failing its own forbidden-syntax scan on its rationale. */
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(sel >= 0 && projection.length > 60,
    'POSITIVE CONTROL: the projection must actually have been located, not sliced to nothing');
  /*
   * Shipping certificate_enabled would let the app render a trophy for a course
   * the technician has not earned — the flag says the course OFFERS one.
   */
  assert.doesNotMatch(projection, /certificate_enabled/,
    'the app must not be able to draw a trophy from the course\'s offer alone');
});

/* ── The technician's own download ────────────────────────────────────────── */

test('the mobile certificate route takes NO technician id from the request', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/mobile/lms.js'), 'utf8');
  const i = src.indexOf("/courses/:courseId/certificate");
  assert.ok(i > 0, 'the technician self-serve route must exist');
  const block = src.slice(i, i + 1600);
  assert.match(block, /req\.tech\.efr_id/, 'identity comes from the verified token');
  assert.doesNotMatch(block, /req\.(params|query|body)\.(efrId|easyfixerId|efr_id)/,
    'a request-supplied id would let any technician fetch another one\'s certificate');
  assert.match(block, /application\/pdf/);
  assert.match(block, /no-store/);
  assert.match(block, /await lms\.certificateData[\s\S]*renderCertificatePdf/,
    'fetch before piping — once the stream starts a 404 can no longer be sent');
});

test('a RETIRED course still reaches the technician if they earned its badge', () => {
  /*
   * The gap the durability claim actually had. certificateData() and the CRM
   * were already safe, but the technician's own list filtered on c.status = 1 —
   * so retiring a course removed the row entirely, taking the trophy and the
   * download button with it. Filtering the LIST revoked what the entitlement
   * was designed to keep.
   */
  const src = fs.readFileSync(path.join(ROOT, 'services/lms.service.js'), 'utf8');
  const i = src.indexOf('async function coursesForTech');
  const block = src.slice(i, i + 3000);
  assert.match(block, /c\.status = 1 OR ec\.badge_earned_at IS NOT NULL/,
    'an earned badge must outlive the course it came from, on every surface');
  assert.doesNotMatch(block, /WHERE ec\.easyfixer_id = \? AND c\.status = 1\b/,
    'the bare status filter is what revoked it');
});
