-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-08 — One manual certificate per form, not one per download.
--
-- REPORTED: an operator filled the form once and clicked PDF, then PNG. Two
-- rows, EF-GEN-2026-0001 and EF-GEN-2026-0002, identical in every field. The
-- holder ends up with two documents bearing different numbers for one award,
-- and a validation lookup cannot say which is the real one.
--
-- WHY THE LMS PATH DOES NOT HAVE THIS. issueForEnrolment is keyed on
-- enrolment_id, so downloading a technician's certificate from the CRM and
-- again from the app returns one row. Manual issuance had NO key: the recipient
-- may exist in no table here, so there is no natural one to derive.
--
-- WHY NOT HASH THE CONTENT. Deriving the key from the printed fields would make
-- two genuinely different people who share a name, a course and a date collide
-- into one certificate number — a real possibility on an induction course run
-- for a batch on one day, and silent when it happens. The key must identify the
-- ACT of issuing, not the text.
--
-- SO THE PAGE SUPPLIES IT. The CRM mints a UUID when the form loads and again
-- whenever any field changes, and sends it with every download. Same form,
-- three formats -> one row and one number. Change a field, or reload the page,
-- and the next download is a new issuance. That is exactly the behaviour asked
-- for, and it is the ordinary idempotency-key pattern rather than an invention.
--
-- NULLABLE ON PURPOSE, like uq_certificate_enrolment beside it. MySQL permits
-- many NULLs in a UNIQUE index, so a caller that sends no key (an older CRM
-- build, or a direct API call) keeps today's behaviour of one row per request
-- instead of colliding with every other keyless row. The column is additive and
-- the endpoint stays backward-compatible.
--
-- The two duplicate rows already issued are NOT touched here. They are real
-- issuances that someone may hold a copy of, and deciding which to withdraw is
-- an operational call, not a migration's.
-- ─────────────────────────────────────────────────────────────────────

-- ─── 1. What exists now (read-only) ──────────────────────────────────
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' ORDER BY ORDINAL_POSITION;

-- ─── 2. Already applied? Expect 0 rows on a first run ────────────────
SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' AND COLUMN_NAME = 'issue_key';

-- ─── 3. The column and its index ─────────────────────────────────────
-- Two statements rather than one ALTER with both clauses, so a re-run that
-- fails on the column having been added does not also skip the index.
ALTER TABLE tbl_certificate ADD COLUMN issue_key VARCHAR(64) NULL;

ALTER TABLE tbl_certificate ADD UNIQUE KEY uq_certificate_issue_key (issue_key);

-- ─── 4. Verify ───────────────────────────────────────────────────────
SELECT 'issue_key present' AS what, COUNT(*) AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' AND COLUMN_NAME = 'issue_key'
UNION ALL SELECT 'issue_key is NULLABLE (keyless callers must not collide)', COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' AND COLUMN_NAME = 'issue_key' AND IS_NULLABLE = 'YES'
UNION ALL SELECT 'uq_certificate_issue_key is UNIQUE', COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_certificate' AND INDEX_NAME = 'uq_certificate_issue_key' AND NON_UNIQUE = 0
UNION ALL SELECT 'existing rows keep their numbers', COUNT(*) FROM tbl_certificate WHERE certificate_no IS NOT NULL;
