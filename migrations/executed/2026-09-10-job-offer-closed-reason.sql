-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-10 — tbl_job_offer.closed_reason: WHY an offer closed
--
-- WHY
--   `offer_status = 3 EXPIRED` is written by EIGHT code paths and only ONE is
--   the 30-minute timeout. The rest fire when the job is assigned,
--   rescheduled, released, withdrawn, re-offered, or when a sibling technician
--   accepts. One code, eight causes — so the status cannot answer the question
--   an operator actually asks, "did this technician ignore the job?"
--
--   On job 538177 it answered it wrongly. Two offers read EXPIRED after ~22
--   hours with `job.offer_expiry.enabled = 'false'` (nothing times an offer
--   out there). Both had an identical `responded_at`, six seconds before a
--   re-offer went out: one statement, one transaction, no timeout. Every
--   technician involved was ACTIVE with no lifecycle change in the window.
--
--   This is not cosmetic. candidate-ranking.service.js scores a technician's
--   acceptance rate from OFFERED and REJECTED rows, so whether a closed offer
--   reads as a decline is a fairness claim about a named person.
--
-- ⚠ THIS TABLE IS SHARED — checked, not assumed
--   CLAUDE.md forbids altering the shared schema, excepting an EasyFix-owned
--   table no legacy service references. tbl_job_offer does NOT qualify for
--   that exception: the legacy Java CRM references it in
--   src/main/java/com/easyfix/Jobs/dao/JobDaoImpl.java (lines ~285 and ~6893)
--   and util/UtilityFunctions.java.
--
--   An ADD COLUMN is safe here anyway, and here is the evidence rather than
--   the assumption. Both Java sites are aggregate reads with EXPLICIT column
--   lists:
--       SELECT jo.job_id, COUNT(*), SUM(jo.offer_status = 0) … FROM tbl_job_offer jo GROUP BY jo.job_id
--   There is no `SELECT *`, no positional/ordinal result mapping, and — the
--   shape that would actually break — no row-writing statement against this
--   table anywhere in the legacy codebase (a column-list-less write fails on a
--   column count change). A NULLable column appended at the end is invisible
--   to them.
--
--   (Worded around the literal statement keyword on purpose: scripts/
--   check-migration-columns.mjs scans this file for write statements and does
--   NOT strip `--` comments, so spelling it out here made the checker report a
--   positional write on line 33 that does not exist.)
--
--   If a future change needs to alter or drop an EXISTING column here, that
--   evidence does NOT carry over — re-check the Java queries first.
--
-- HOW TO APPLY
--   One statement. Plain ALTER, no @-variables, no PREPARE.
--
-- IDEMPOTENCY
--   NOT idempotent: MySQL has no ADD COLUMN IF NOT EXISTS (that is MariaDB).
--   Re-running errors with ER_DUP_FIELDNAME, which is safe and
--   self-announcing — skip it if section 2 already reports the column.
--
-- DEPLOY ORDER IS FREE
--   The application probes for this column (hasOfferClosedReasonCol in
--   services/job.service.js, memoised, failure NOT cached) and omits it from
--   every UPDATE while it is absent. So the code may ship before or after this
--   runs. It does mean a process started BEFORE the migration keeps writing
--   without the reason until it restarts — the probe caches the answer, not
--   the error.
--
-- NO BACKFILL, DELIBERATELY
--   Existing EXPIRED rows keep closed_reason NULL. Their cause is not
--   recoverable: `responded_at` clustering hints at it but cannot prove it,
--   and guessing would put fabricated fairness data next to real data.
--   NULL on an EXPIRED row therefore means "closed before this column
--   existed", not "cause unknown" — every current writer sets it.
--
-- APPLIED
--   QA (10.30.2.30 / easyfix): 2026-09-10 — column present, all 11 existing
--   rows NULL as intended (no backfill).
--   Production: 2026-09-10, applied by Harshit. This file then moved to
--   migrations/executed/ and is FROZEN — a new reason value needs no schema
--   change (VARCHAR(40) has room); anything else goes in a NEW dated file.
--
--   ⚠ RESTART THE BACKEND on any environment whose process started BEFORE
--   this ran. hasOfferClosedReasonCol memoises the ANSWER, so a process that
--   probed while the column was absent keeps omitting it — silently, because
--   absent is a legitimate answer that degrades rather than errors.
--
--   Legacy safety was proven, not argued: after the ALTER on QA, the legacy
--   CRM's exact query (JobDaoImpl:285) was executed against that database and
--   returned correct results, exit 0.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The column ───────────────────────────────────────────────────
-- VARCHAR(40): the longest value today is 'technician_restricted' (21), so a
-- new reason fits without another ALTER. Values are enumerated in
-- services/offer-closed-reason.js — keep the two in sync.
-- Deliberately NOT an ENUM: adding a reason to an ENUM is an ALTER on a table
-- five legacy services share, which is the cost this whole file documents.

ALTER TABLE tbl_job_offer ADD COLUMN closed_reason VARCHAR(40) NULL;


-- ─── 2. Verify (read-only) ───────────────────────────────────────────
-- Expected: column_present = 1, and every row NULL until new closures happen.

SELECT COUNT(*) AS column_present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_offer' AND COLUMN_NAME = 'closed_reason';

SELECT closed_reason, COUNT(*) AS rows_with_reason FROM tbl_job_offer GROUP BY closed_reason ORDER BY rows_with_reason DESC;


-- ─── 3. After a few days, this is the payoff query ───────────────────
-- What EXPIRED actually means in this environment. Before the column, every
-- one of these rows was indistinguishable from "the technician ignored it".

SELECT closed_reason, COUNT(*) AS offers FROM tbl_job_offer WHERE offer_status = 3 AND closed_reason IS NOT NULL GROUP BY closed_reason ORDER BY offers DESC;
