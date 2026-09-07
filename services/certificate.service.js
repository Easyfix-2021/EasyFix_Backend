'use strict';

const { pool } = require('../db');
const logger = require('../logger');
const { certificatePayload } = require('./lms.service');
const { formatDate } = require('../utils/pdf-certificate');
const { todayIst } = require('../utils/ist-calendar');

/*
 * certificate.service — THE ONLY MODULE THAT TOUCHES tbl_certificate.
 *
 * ─── WHY THERE IS A TABLE AT ALL ───────────────────────────────────────────
 *
 * Certificates shipped deliberately stateless: a pure projection, which is what
 * let one be issued to somebody who is in no table here. That holds right up
 * until an operator has to answer "is EF-TR-2026-0042 real?" — a number nobody
 * recorded can only be RECOMPUTED, and only for the LMS half. Validation needs
 * an issuance. migrations/2026-09-07-create-tbl-certificate.sql is the issuance;
 * this file is the only writer and the only reader of it.
 *
 * ─── ONE RECORD PER CERTIFICATE, NOT PER DOWNLOAD ──────────────────────────
 *
 * An LMS certificate is served repeatedly — the CRM's Training Report and the
 * technician's own app both download it — so issuance must not follow the
 * download. `uq_certificate_enrolment` IS that rule, and issueForEnrolment
 * upserts against it rather than doing SELECT-then-INSERT, which would let two
 * concurrent downloads both find nothing and both insert.
 *
 * ─── NUMBERS ARE SERVER-ISSUED, NEVER OPERATOR-TYPED ───────────────────────
 *
 *   LMS     EF-TR-<completion year>-<enrolment id, min 4 digits>
 *   manual  EF-GEN-<issue year>-<this row's id, min 4 digits>
 *
 * Neither spelling is restated here. The LMS one comes back from
 * lms.service::certificatePayload — which calls certificateNumber() — so the
 * stored number cannot drift from the printed one; the manual one is derived
 * from the AUTO_INCREMENT id the insert already returned, so it needs no
 * counter table and cannot collide. uq_certificate_no is the backstop.
 *
 * ─── EVERY VALUE IS A `?` ──────────────────────────────────────────────────
 *
 * Including the ones that are constants ('lms', 'manual', the NULL number).
 * Parameterised SQL is the house rule anyway, and here it buys a second thing:
 * the column list and the parameter list line up one-for-one, which is what
 * lets tests/certificate-issue.test.js stand a real unique index up in front of
 * these statements instead of guessing at positions.
 */

const COLUMNS = `id, certificate_no, source, recipient_name, title, heading, eyebrow,
                 date_text, signatory_name, signatory_title, efr_id, course_id,
                 enrolment_id, issued_by, issued_on`;

/*
 * Record the LMS certificate for one enrolment, idempotently.
 *
 * `row` is a lms.service::certificateData() row. The printed strings are taken
 * from certificatePayload() rather than rebuilt, so the record IS the document:
 * a re-issue years from now reproduces what the holder has, even if
 * completion_date is corrected in the meantime.
 *
 * ON DUPLICATE KEY UPDATE id = id is a deliberate no-op — the SECOND download
 * must not overwrite the first issuance, only find it. The re-SELECT then
 * returns whichever row won, so the caller always gets the stored record and
 * never the one it tried to write.
 *
 * IT BURNS AN AUTO_INCREMENT VALUE EVERY TIME IT NO-OPS. Measured on QA 8.4:
 * two issues of one enrolment left ids 1 and 2 consumed, so the next manual
 * certificate was EF-GEN-…-0004, not 0002. InnoDB allocates before it detects
 * the duplicate. That is why the manual sequence is a SEQUENCE and not a
 * COUNT — gaps are normal and mean nothing, and at INT range a download would
 * have to be served two billion times to matter.
 */
async function issueForEnrolment(row) {
  const p = certificatePayload(row);
  await pool.query(
    `INSERT INTO tbl_certificate
       (certificate_no, source, recipient_name, title, date_text,
        signatory_name, signatory_title, efr_id, course_id, enrolment_id, issued_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [p.certificateId, 'lms', p.recipientName, p.title, p.dateText,
      p.signatoryName ?? null, p.signatoryTitle ?? null,
      row.efr_id == null ? null : Number(row.efr_id),
      row.course_id == null ? null : Number(row.course_id),
      Number(row.enrolment_id), new Date()],
  );
  const [[rec]] = await pool.query(
    `SELECT ${COLUMNS} FROM tbl_certificate WHERE enrolment_id = ?`,
    [Number(row.enrolment_id)],
  );
  return rec || null;
}

/*
 * Record a manually-issued certificate and give it its number.
 *
 * INSERT FIRST, NUMBER SECOND. There is no natural key to derive from — the
 * recipient may exist in no table here at all — so the number comes from the
 * row's own AUTO_INCREMENT id, which only exists once the row does. Two
 * statements, no counter table, no allocation race.
 *
 * enrolment_id stays NULL, and MySQL permits many NULLs in a UNIQUE index, so
 * manual rows never collide with each other on uq_certificate_enrolment.
 *
 * IDEMPOTENT ON issue_key (2026-09-08). Reported: one filled form, a click on
 * PDF and then on PNG, two rows and two numbers for one award. The LMS path
 * never had this because enrolment_id keys it; manual issuance had no key at
 * all, since the recipient may exist in no table here.
 *
 * The key identifies the ACT of issuing, not the text — the CRM mints a UUID
 * when the form loads and again whenever a field changes. Hashing the printed
 * fields instead would collide two different people who share a name, a course
 * and a date, which is an ordinary occurrence on a batch induction and silent
 * when it happens.
 *
 * A caller that sends no key keeps the old behaviour of one row per request:
 * issue_key is NULL and MySQL allows many NULLs in a unique index, so keyless
 * rows never collide with each other. That is what keeps an older CRM build
 * working against a newer backend.
 *
 * dateText is resolved to what the renderer WOULD print when the caller omits
 * it: `undefined` means "today in IST" to utils/pdf-certificate, and storing
 * NULL instead would make a re-issue print a different date from the holder's
 * copy. `''` is a different request — "no date pair" — and is stored verbatim.
 */
async function issueManual(values, actor) {
  const v = values || {};
  const key = typeof v.issueKey === 'string' && v.issueKey.trim() !== ''
    ? v.issueKey.trim().slice(0, 64)
    : null;

  /*
   * Return the existing issuance before writing anything. The unique index is
   * still the guarantee — this read only avoids burning an AUTO_INCREMENT id
   * on the common case, where an operator clicks PDF then PNG a second apart.
   */
  if (key) {
    const [[found]] = await pool.query(
      `SELECT ${COLUMNS} FROM tbl_certificate WHERE issue_key = ?`, [key]);
    if (found) return found;
  }

  const [ins] = await pool.query(
    `INSERT INTO tbl_certificate
       (certificate_no, source, recipient_name, title, heading, eyebrow, date_text,
        signatory_name, signatory_title, issued_by, issued_on, issue_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [null, 'manual', String(v.recipientName), String(v.title),
      v.heading ?? null, v.eyebrow ?? null,
      v.dateText === undefined ? formatDate(todayIst()) : v.dateText,
      v.signatoryName ?? null, v.signatoryTitle ?? null,
      actor == null ? null : Number(actor), new Date(), key],
  );

  /*
   * insertId is 0 when ON DUPLICATE KEY UPDATE matched — two downloads a
   * millisecond apart, past the read above. The row exists; read it by key.
   */
  if (!ins.insertId && key) {
    const [[raced]] = await pool.query(
      `SELECT ${COLUMNS} FROM tbl_certificate WHERE issue_key = ?`, [key]);
    if (raced) return raced;
  }
  /*
   * The YEAR is IST, matching issued_on — which the pool's +05:30 session
   * stores verbatim. The server clock is UTC in every container, so reading the
   * year off it would file a 03:00 IST certificate under the previous year for
   * four and a half hours every 1 January.
   */
  const no = `EF-GEN-${todayIst().slice(0, 4)}-${String(ins.insertId).padStart(4, '0')}`;
  await pool.query('UPDATE tbl_certificate SET certificate_no = ? WHERE id = ?',
    [no, ins.insertId]);
  logger.info('Certificate issued · no=' + no + ' · recipient=' + v.recipientName
    + ' · by=' + (actor ?? '-'));
  const [[rec]] = await pool.query(
    `SELECT ${COLUMNS} FROM tbl_certificate WHERE id = ?`, [ins.insertId]);
  return rec || null;
}

/*
 * The lookup a validation endpoint will be built on: given the number printed
 * on a document, the issuance record or null. No route exposes it yet — who may
 * validate a certificate, and how much of the record they see, is a separate
 * decision from recording one.
 */
async function findByNumber(no) {
  if (!no) return null;
  const [[rec]] = await pool.query(
    `SELECT ${COLUMNS} FROM tbl_certificate WHERE certificate_no = ?`, [String(no).trim()]);
  return rec || null;
}

module.exports = { issueForEnrolment, issueManual, findByNumber };
