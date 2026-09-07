'use strict';
/*
 * Certificates as RECORDS — services/certificate.service.js.
 *
 * ─── WHY THIS FILE STANDS A UNIQUE INDEX UP ────────────────────────────────
 *
 * The idempotency of an LMS certificate is not in the JavaScript. It is
 * `uq_certificate_enrolment`, and the service's only job is to write a
 * statement that survives hitting it. A fake pool that answers every INSERT
 * with "ok" therefore cannot tell an idempotent upsert from a plain INSERT that
 * would throw ER_DUP_ENTRY on the second download — it would pass both, which
 * is the shape of a gate that reads as coverage and is not.
 *
 * So the fake here is a tiny in-memory TABLE that enforces both unique indexes
 * exactly as the migration declares them, NULLs included. Delete
 * `ON DUPLICATE KEY UPDATE` from issueForEnrolment and the second call rejects
 * and the test fails by name. The control on that control is the first test
 * below, which proves the fake can actually fail.
 *
 * The columns are read out of the statement's own column list rather than
 * assumed by position, which is why every value in those INSERTs is a `?` —
 * a literal in VALUES would slide the two lists out of alignment.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installFakePool } = require('./helpers/fake-pool');
const { readMigration } = require('./helpers/migration-file');

const ROOT = path.join(__dirname, '..');

/* ── a tbl_certificate that honours its own indexes ───────────────────────── */

/*
 * The column list comes from the migration itself, so a row this fake hands
 * back has every column — NULL for the ones an INSERT did not name, which is
 * what MySQL returns and what `enrolment_id IS NULL` on a manual row depends
 * on. Deriving it here also fails loudly if the CREATE TABLE is reshaped.
 */
const SCHEMA_COLUMNS = readMigration('2026-09-07-create-tbl-certificate.sql')
  .match(/CREATE TABLE[^(]*\(([\s\S]*?)\n\);/)[1]
  .split('\n').map((l) => (/^\s{2}([a-z_]+)\s/.exec(l) || [])[1]).filter(Boolean);
assert.ok(SCHEMA_COLUMNS.includes('enrolment_id') && SCHEMA_COLUMNS.length >= 15,
  'POSITIVE CONTROL: the schema must actually have been parsed, not sliced to nothing');
const NULL_ROW = Object.fromEntries(SCHEMA_COLUMNS.map((c) => [c, null]));

const table = (() => {
  let rows = [];
  let nextId = 1;

  function columnsOf(sql) {
    const m = /INSERT INTO tbl_certificate\s*\(([\s\S]*?)\)\s*VALUES/i.exec(sql);
    assert.ok(m, 'the insert must name its columns');
    return m[1].split(',').map((s) => s.trim());
  }

  function insert(sql, params) {
    const cols = columnsOf(sql);
    assert.equal(cols.length, params.length,
      'every value must be a ? — a literal in VALUES desynchronises the lists');
    const row = { ...NULL_ROW, ...Object.fromEntries(cols.map((c, i) => [c, params[i]])) };

    /* uq_certificate_enrolment and uq_certificate_no. MySQL permits any number
     * of NULLs in a UNIQUE index, which is the whole reason manual rows (no
     * enrolment) can coexist while LMS rows are held to one per enrolment. */
    for (const [col, key] of [['enrolment_id', 'uq_certificate_enrolment'],
      ['certificate_no', 'uq_certificate_no'],
      /* uq_certificate_issue_key, added 2026-09-08 — same NULL rule: a caller
       * that sends no key gets one row per request, as before. */
      ['issue_key', 'uq_certificate_issue_key']]) {
      if (row[col] == null) continue;
      if (!rows.some((r) => String(r[col]) === String(row[col]))) continue;
      if (/ON DUPLICATE KEY UPDATE/i.test(sql)) return { affectedRows: 0, insertId: 0 };
      const e = new Error(`Duplicate entry '${row[col]}' for key '${key}'`);
      e.code = 'ER_DUP_ENTRY';
      throw e;
    }
    row.id = nextId;
    nextId += 1;
    rows.push(row);
    return { affectedRows: 1, insertId: row.id };
  }

  return {
    insert,
    get rows() { return rows; },
    reset() { rows = []; nextId = 1; },
  };
})();

const fake = installFakePool([
  [/INSERT INTO tbl_certificate/i, (sql, p) => table.insert(sql, p)],
  [/UPDATE tbl_certificate SET certificate_no/i, (sql, p) => {
    const r = table.rows.find((x) => x.id === p[1]);
    if (r) r.certificate_no = p[0];
    return { affectedRows: r ? 1 : 0 };
  }],
  [/FROM tbl_certificate WHERE enrolment_id/i, (sql, p) => table.rows
    .filter((r) => Number(r.enrolment_id) === Number(p[0]))],
  [/FROM tbl_certificate WHERE certificate_no/i, (sql, p) => table.rows
    .filter((r) => r.certificate_no === p[0])],
  /* Added with uq_certificate_issue_key: issueManual reads by key before it
   * writes, and again if ON DUPLICATE matched past that read. */
  [/FROM tbl_certificate WHERE issue_key/i, (sql, p) => table.rows
    .filter((r) => r.issue_key != null && r.issue_key === p[0])],
  [/FROM tbl_certificate WHERE id = \?/i, (sql, p) => table.rows
    .filter((r) => Number(r.id) === Number(p[0]))],
]);
after(() => fake.restore());

const svc = require('../services/certificate.service');

/* The shape lms.service::certificateData returns, including the two columns it
 * now carries so the row alone is enough to record the issuance. */
const ROW = {
  enrolment_id: 42,
  efr_id: 7001,
  course_id: 3,
  completion_date: '2026-08-30 14:22:10',
  badge_earned_at: '2026-09-02 09:00:00',
  score: 88,
  course_name: 'Induction & Safety',
  efr_name: 'Ramesh Kumar',
  efr_no: '9876543210',
};

/* ── the control on the control ───────────────────────────────────────────── */

test('POSITIVE CONTROL: the fake table really rejects a duplicate enrolment', () => {
  table.reset();
  const plain = 'INSERT INTO tbl_certificate (enrolment_id, source) VALUES (?, ?)';
  table.insert(plain, [42, 'lms']);
  assert.throws(() => table.insert(plain, [42, 'lms']), /ER_DUP_ENTRY|Duplicate entry/,
    'if this passes, every idempotency assertion below is vacuous');
  /* …and NULL enrolments must NOT collide, or manual certificates break. */
  table.insert(plain, [null, 'manual']);
  table.insert(plain, [null, 'manual']);
  assert.equal(table.rows.length, 3);
});

/* ── one record per certificate, not per download ─────────────────────────── */

test('the same enrolment issued twice is ONE row with ONE number', async () => {
  table.reset();
  const first = await svc.issueForEnrolment(ROW);
  const second = await svc.issueForEnrolment(ROW);

  assert.equal(table.rows.length, 1,
    'a second download must find the issuance, not create one');
  assert.equal(first.certificate_no, second.certificate_no,
    "the number on a technician's certificate must never change");
  assert.equal(first.id, second.id);
});

test('the number is the LMS one, taken from lms.service and not restated', async () => {
  table.reset();
  const rec = await svc.issueForEnrolment(ROW);
  const lms = require('../services/lms.service');
  assert.equal(rec.certificate_no, lms.certificateNumber(ROW));
  assert.equal(rec.certificate_no, 'EF-TR-2026-0042',
    'year from completion_date, enrolment id padded to four');
});

test('a re-issue reproduces the DOCUMENT, so the printed strings are stored', async () => {
  table.reset();
  const rec = await svc.issueForEnrolment(ROW);
  const { certificatePayload } = require('../services/lms.service');
  const printed = certificatePayload(ROW);
  assert.equal(rec.recipient_name, printed.recipientName);
  assert.equal(rec.title, printed.title);
  assert.equal(rec.date_text, printed.dateText);
  assert.equal(rec.signatory_name, printed.signatoryName);
  assert.equal(rec.signatory_title, printed.signatoryTitle);
  assert.equal(rec.source, 'lms');
  assert.equal(Number(rec.efr_id), ROW.efr_id);
  assert.equal(Number(rec.course_id), ROW.course_id);
});

test('the FIRST issuance wins — a later download cannot rewrite it', async () => {
  table.reset();
  const first = await svc.issueForEnrolment(ROW);
  /* completion_date corrected after the certificate is already in a
   * technician's hands; the record must still be what he holds. */
  const second = await svc.issueForEnrolment({ ...ROW, completion_date: '2027-01-05 10:00:00' });
  assert.equal(second.certificate_no, first.certificate_no);
  assert.equal(second.date_text, first.date_text);
  assert.equal(table.rows.length, 1);
});

/* ── manual issuance ──────────────────────────────────────────────────────── */

const MANUAL = { recipientName: 'Sunita Devi', title: 'Ten Years of Service' };

test('two manual certificates get distinct, sequential numbers', async () => {
  table.reset();
  const a = await svc.issueManual(MANUAL, 12);
  const b = await svc.issueManual(MANUAL, 12);
  assert.match(a.certificate_no, /^EF-GEN-\d{4}-\d{4,}$/);
  assert.notEqual(a.certificate_no, b.certificate_no,
    'an operator issuing twice has issued two documents');
  assert.equal(Number(b.id), Number(a.id) + 1);
  assert.equal(b.certificate_no, `EF-GEN-${a.certificate_no.split('-')[2]}-`
    + String(Number(a.id) + 1).padStart(4, '0'));
  assert.equal(table.rows.length, 2);
  assert.equal(a.enrolment_id, null, 'manual rows carry no enrolment, so they never collide');
  assert.equal(Number(a.issued_by), 12);
  assert.equal(a.source, 'manual');
});

test('an omitted dateText is stored as what the renderer WOULD print', async () => {
  table.reset();
  const { formatDate } = require('../utils/pdf-certificate');
  const { todayIst } = require('../utils/ist-calendar');
  const auto = await svc.issueManual(MANUAL, null);
  assert.equal(auto.date_text, formatDate(todayIst()),
    'storing NULL would make a re-issue print a different date from the holder\'s copy');

  /* '' is a DIFFERENT request — "no date pair at all" — and survives verbatim. */
  const none = await svc.issueManual({ ...MANUAL, dateText: '' }, null);
  assert.equal(none.date_text, '');
  const given = await svc.issueManual({ ...MANUAL, dateText: '01 April 2019' }, null);
  assert.equal(given.date_text, '01 April 2019');
});

test('the manual year is IST, not the container\'s UTC clock', (t) => {
  table.reset();
  /* 20:00 UTC on 31 Dec is 01:30 IST on 1 Jan. A number read off the server
   * clock files that certificate under the previous year. */
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T20:00:00Z') });
  const { todayIst } = require('../utils/ist-calendar');
  assert.equal(todayIst().slice(0, 4), '2027', 'POSITIVE CONTROL: the clock really is mocked');
  return svc.issueManual(MANUAL, null).then((rec) => {
    assert.equal(rec.certificate_no.split('-')[2], '2027');
    t.mock.timers.reset();
  }, (e) => { t.mock.timers.reset(); throw e; });
});

/* ── the lookup a validation endpoint will use ────────────────────────────── */

test('findByNumber returns the issuance, or null', async () => {
  table.reset();
  const lms = await svc.issueForEnrolment(ROW);
  const manual = await svc.issueManual(MANUAL, 12);

  assert.equal((await svc.findByNumber(lms.certificate_no)).id, lms.id);
  assert.equal((await svc.findByNumber(manual.certificate_no)).id, manual.id);
  const padded = await svc.findByNumber(`  ${lms.certificate_no} `);
  assert.equal(padded && padded.id, lms.id,
    'an operator retyping a number off a document brings whitespace with it');
  assert.equal(await svc.findByNumber('EF-TR-2026-9999'), null,
    'an unknown number is null, never a fabricated record');
  assert.equal(await svc.findByNumber(''), null);
  assert.equal(await svc.findByNumber(null), null);
});

test('no route exposes findByNumber yet', () => {
  const routes = fs.readdirSync(path.join(ROOT, 'routes'), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'routes', String(f)), 'utf8'));
  assert.equal(routes.some((s) => /findByNumber/.test(s)), false,
    'who may validate a certificate is a separate decision from recording one');
});

/* ── one writer, and recording that cannot break a download ───────────────── */

test('tbl_certificate has exactly ONE module that touches it', () => {
  const dirs = ['services', 'routes', 'utils', 'lib', 'scripts'];
  const hits = [];
  for (const d of dirs) {
    const base = path.join(ROOT, d);
    if (!fs.existsSync(base)) continue;
    for (const f of fs.readdirSync(base, { recursive: true })) {
      const p = path.join(base, String(f));
      if (!String(f).endsWith('.js') || !fs.statSync(p).isFile()) continue;
      if (/tbl_certificate\b/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.join(d, String(f)));
    }
  }
  assert.deepEqual(hits, ['services/certificate.service.js'],
    'a second writer is free to skip the unique index that IS the idempotency');
});

test('both LMS downloads record BEFORE rendering, and fail open', () => {
  for (const rel of ['routes/admin/lms.js', 'routes/mobile/lms.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /certificateData\([\s\S]*?issueForEnrolment\([\s\S]*?renderCertificatePdf/,
      `${rel}: the issuance must be recorded before the document is served`);
    assert.match(src, /issueForEnrolment\([\s\S]{0,300}?\.catch\(/,
      `${rel}: a technician's certificate matters more than our bookkeeping`);
  }
});

/* ── the table this rests on ──────────────────────────────────────────────── */

test('one form is one issuance, however many formats are downloaded', async () => {
  /*
   * Reported 2026-09-08: an operator filled the form once and clicked PDF then
   * PNG. Two rows, EF-GEN-2026-0001 and -0002 — two numbers for one award,
   * with nothing to tell a later lookup which is real. Pressing a second FORMAT
   * button is not issuing a second document.
   */
  table.reset();
  const form = { recipientName: 'Harshit', title: 'Introduction to Easyfix', issueKey: 'form-abc' };

  const pdf = await svc.issueManual(form, 2);
  const png = await svc.issueManual(form, 2);
  const jpg = await svc.issueManual(form, 2);

  assert.equal(png.certificate_no, pdf.certificate_no, 'a second FORMAT must reuse the number');
  assert.equal(jpg.certificate_no, pdf.certificate_no);
  assert.equal(table.rows.length, 1, 'three downloads of one form are one row');
});

test('an edited field is a NEW issuance, and a keyless caller is unaffected', async () => {
  table.reset();
  const form = { recipientName: 'Harshit', title: 'Introduction to Easyfix', issueKey: 'form-abc' };
  const first = await svc.issueManual(form, 2);

  /* The page mints a fresh key whenever a value changes, which IS a new award. */
  const edited = await svc.issueManual({ ...form, title: 'Advanced', issueKey: 'form-xyz' }, 2);
  assert.notEqual(edited.certificate_no, first.certificate_no);
  assert.equal(table.rows.length, 2);

  /*
   * And a caller that sends NO key keeps the old one-row-per-request rule —
   * issue_key is NULL, and MySQL permits any number of NULLs in a unique index.
   * Without this, an older CRM build would collide with every other keyless
   * call and silently reuse a stranger's certificate number.
   */
  const a = await svc.issueManual({ recipientName: 'A', title: 'T' }, 2);
  const b = await svc.issueManual({ recipientName: 'A', title: 'T' }, 2);
  assert.notEqual(a.certificate_no, b.certificate_no);
  assert.equal(table.rows.length, 4);
});

test('the migration declares the indexes the service relies on', () => {
  /* Comments stripped first — the header EXPLAINS the omissions by naming
   * them, so a raw scan reads the rationale as a violation. */
  const sql = readMigration('2026-09-07-create-tbl-certificate.sql')
    .replace(/^\s*--.*$/gm, '');
  assert.match(sql, /UNIQUE KEY uq_certificate_enrolment \(enrolment_id\)/,
    'this index IS the one-record-per-certificate rule');
  assert.match(sql, /UNIQUE KEY uq_certificate_no \(certificate_no\)/);
  /*
   * The third index lives in a LATER migration, because the table was already
   * in QA and Production by the time one download per FORMAT was found to be
   * issuing one certificate per click.
   */
  const alter = readMigration('2026-09-08-certificate-issue-key.sql');
  assert.match(alter, /ADD COLUMN issue_key VARCHAR\(64\) NULL/,
    'nullable, so a keyless caller does not collide with every other keyless caller');
  assert.match(alter, /ADD UNIQUE KEY uq_certificate_issue_key \(issue_key\)/);
  assert.match(sql, /enrolment_id\s+INT NULL/,
    'NULLABLE, or two manual certificates collide on the enrolment index');
  assert.match(sql, /issued_on\s+DATETIME NOT NULL/);
  assert.doesNotMatch(sql, /DEFAULT CURRENT_TIMESTAMP/,
    'the app writes issued_on so the pool\'s +05:30 stores IST verbatim');
  assert.doesNotMatch(sql, /ALTER TABLE|DROP TABLE/,
    'the shared-schema carve-out is a NEW table, nothing else');
});
