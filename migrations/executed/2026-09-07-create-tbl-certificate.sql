-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-07 — Certificates become records, so a Certificate ID can be
--              validated later.
--
-- WHY THIS REVERSES AN EARLIER DECISION
--   Certificates shipped deliberately stateless: a pure projection of facts
--   that already existed, which is what let one be issued to a person who is
--   not in this database at all. That holds right up until somebody has to
--   answer "is EF-TR-2026-0042 real?" — and a number nobody recorded cannot be
--   answered, only recomputed, and only for the LMS half. Validation needs an
--   issuance, so this is the table that issues.
--
-- SHARED-DB RULE — THE DOCUMENTED EXCEPTION
--   CLAUDE.md forbids altering the shared `easyfix_core` schema. Its stated
--   carve-out is an EASYFIX-OWNED NEW TABLE THAT NO LEGACY SERVICE REFERENCES,
--   already used by tbl_pincode (2026-05-01), tbl_user_allowed_stages
--   (2026-07-29), tbl_user_personal_details (2026-08-03),
--   tbl_sensitive_reveal_log (2026-09-01) and tbl_job_permission_request
--   (2026-09-07). This table is written and read only by
--   services/certificate.service.js in this backend. NOTHING existing is
--   altered by this file.
--
-- ── ONE RECORD PER CERTIFICATE, NOT PER DOWNLOAD ────────────────────────
--   An LMS certificate is downloaded many times — the CRM's Training Report
--   and the technician's own app both serve it. If each download issued a
--   number, the same technician's certificate would carry a different one
--   every time and validation would mean nothing. `uq_certificate_enrolment`
--   enforces one row per enrolment, and the service upserts against it.
--
--   That unique index is on a NULLABLE column on purpose. MySQL permits many
--   NULLs in a UNIQUE index, so manually-issued certificates (no enrolment)
--   never collide with each other, while LMS ones are held to exactly one per
--   enrolment. One index, both rules, no conditional logic in the service.
--
-- ── WHY THE PRINTED TEXT IS STORED, NOT JUST THE IDS ────────────────────
--   date_text, heading, eyebrow and the signatory pair are kept verbatim so a
--   re-issue reproduces the DOCUMENT, not today's rendering of it. A
--   certificate is a claim about a moment; recomputing the date from
--   completion_date years later would silently reprint a different one if that
--   row is ever corrected, and the holder's copy would no longer match ours.
--
--   recipient_name is stored for the same reason and for a stronger one: a
--   manual certificate's recipient may exist in no table here at all.
--
-- ── THE NUMBER ─────────────────────────────────────────────────────────
--   Server-issued, never operator-typed — a typed number looks official and
--   validates as unknown, and nothing stops two certificates sharing it.
--     LMS     EF-TR-<completion year>-<enrolment id, min 4 digits>
--     manual  EF-GEN-<issue year>-<this table's id, min 4 digits>
--   The manual form derives from the row's own AUTO_INCREMENT, so it needs no
--   counter table and cannot collide: insert, then render with the id you got
--   back. uq_certificate_no is the backstop.
--
-- ── DATETIME, NOT TIMESTAMP ────────────────────────────────────────────
--   issued_on is written by the app as `new Date()` against a pool whose
--   session timezone is +05:30, so IST is stored verbatim — the convention
--   every other EasyFix-owned table here follows. No DEFAULT CURRENT_TIMESTAMP
--   on purpose: server-clock UTC would silently mix timezones into the column.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_certificate (
  id               INT NOT NULL AUTO_INCREMENT,
  certificate_no   VARCHAR(40)  NULL,
  source           VARCHAR(16)  NOT NULL,
  recipient_name   VARCHAR(120) NOT NULL,
  title            VARCHAR(160) NOT NULL,
  heading          VARCHAR(80)  NULL,
  eyebrow          VARCHAR(120) NULL,
  date_text        VARCHAR(60)  NULL,
  signatory_name   VARCHAR(80)  NULL,
  signatory_title  VARCHAR(80)  NULL,
  efr_id           INT NULL,
  course_id        INT NULL,
  enrolment_id     INT NULL,
  issued_by        INT NULL,
  issued_on        DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_certificate_no (certificate_no),
  UNIQUE KEY uq_certificate_enrolment (enrolment_id),
  KEY idx_certificate_efr (efr_id),
  KEY idx_certificate_issued_on (issued_on)
);

-- ─── Verify ──────────────────────────────────────────────────────────
SELECT 'table present' AS what, COUNT(*) AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate'
UNION ALL SELECT 'certificate_no is unique', COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' AND INDEX_NAME = 'uq_certificate_no' AND NON_UNIQUE = 0
UNION ALL SELECT 'one row per enrolment', COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' AND INDEX_NAME = 'uq_certificate_enrolment' AND NON_UNIQUE = 0
UNION ALL SELECT 'enrolment_id is NULLABLE (manual rows must not collide)', COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' AND COLUMN_NAME = 'enrolment_id' AND IS_NULLABLE = 'YES'
UNION ALL SELECT 'issued_on has no CURRENT_TIMESTAMP default', COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' AND COLUMN_NAME = 'issued_on' AND COLUMN_DEFAULT IS NULL;
