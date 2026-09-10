-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-10 — Issue reporter v2: many screenshots, and an email gate on
-- who may triage the queue.
--
-- Follows executed/2026-09-10-crm-issue-reporter.sql, which created
-- tbl_crm_issue and tbl_crm_issue_comment and seeded the isIssueManage
-- action key. NOTHING there is altered by this file.
--
-- Style: plain one-statement-per-line; idempotent (re-run = no-op).
--
-- ── 1. MANY SCREENSHOTS PER ISSUE ───────────────────────────────────
-- tbl_crm_issue.screenshot_key holds at most one key. A reporter almost
-- always has more than one thing to show — the broken screen AND the
-- console, the before AND the after — and was having to pick.
--
-- A CHILD TABLE rather than a CSV in the existing column. The keys are
-- ~27 chars each, so five would fit in the VARCHAR(255) and the eighth
-- would silently truncate: a data-loss ceiling with no error, reached by
-- an ordinary user doing an ordinary thing. This is also the shape
-- tbl_crm_issue_comment already uses for the other one-to-many on this
-- entity — same FK, same ON DELETE CASCADE — so nothing new is invented.
--
-- SHARED-DB RULE — SAME DOCUMENTED EXCEPTION AS THE PARENT FILE.
-- CLAUDE.md forbids altering the shared `easyfix_core` schema; its stated
-- carve-out is an EasyFix-owned NEW table no legacy service references.
-- Verified before writing this file: `grep -rn "tbl_crm_issue_image"
-- migrations/ services/ routes/ validators/ tests/` → 0 hits. The table
-- is written and read by services/issue.service.js and by nothing else.
--
-- ── Column notes ────────────────────────────────────────────────────
-- issue_id    Parent. FK with ON DELETE CASCADE, so deleting an issue
--             takes its images with it — the same contract
--             tbl_crm_issue_comment has. The S3 objects themselves are
--             expired by lifecycle policy on the `Issues/` prefix, not
--             by this constraint.
-- s3_key      S3 key under `Issues/`, e.g. `Issues/1757500000000_a4b9c0d2`.
--             NO file extension — the real MIME rides on the object's
--             Content-Type, the ops convention every other prefix here
--             follows (utils/s3-storage.js). NOT NULL: a row that names
--             no object is not a screenshot, it is a bug.
-- sort_order  The order the reporter attached them in, 0-based. Kept
--             because "the third screenshot" is how people refer to
--             them in the comment thread, and insert order is not a
--             guarantee any query planner owes you.
-- created_on  DATETIME written by the app as new Date(); the pool's
--             +05:30 session timezone (db.js) stores the IST wall clock
--             verbatim. NO DEFAULT CURRENT_TIMESTAMP — the container
--             clock is UTC, so a DB-side default would silently mix two
--             timezones into one column, exactly as the parent file
--             argues for tbl_crm_issue.created_on.

CREATE TABLE IF NOT EXISTS tbl_crm_issue_image (
  id         INT NOT NULL AUTO_INCREMENT,
  issue_id   INT NOT NULL,
  s3_key     VARCHAR(255) NOT NULL,
  sort_order TINYINT NOT NULL DEFAULT 0,
  created_on DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_crm_issue_image_issue (issue_id),
  CONSTRAINT fk_crm_issue_image_issue FOREIGN KEY (issue_id) REFERENCES tbl_crm_issue (id) ON DELETE CASCADE
) ENGINE=InnoDB;


-- ── 2. Move the existing single screenshots into the child table ────
-- Every issue reported since the parent migration went live keeps its
-- screenshot. After this the reader takes images from the child table
-- ONLY, so a row left behind here would look like an issue whose
-- screenshot vanished.
--
-- Idempotent by the NOT EXISTS: a re-run copies nothing twice.
-- tbl_crm_issue.screenshot_key is deliberately NOT dropped — dropping a
-- column is the one thing verify:migrations cannot confirm afterwards
-- (see reference_easyfix_migration_status_check), and leaving it costs
-- nothing. Nothing writes it from now on.

INSERT INTO tbl_crm_issue_image (issue_id, s3_key, sort_order, created_on)
SELECT i.id, i.screenshot_key, 0, i.created_on
  FROM tbl_crm_issue i
 WHERE i.screenshot_key IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tbl_crm_issue_image x WHERE x.issue_id = i.id);


-- ── 3. WHO MAY TRIAGE — an easyfix_properties email allowlist ───────
-- `isIssueManage` (seeded by the parent file, granted to Admin) says the
-- Reported Issues screen EXISTS. This key says who may reach it. BOTH
-- must pass — the same two-lock arrangement secrets.manager.emails uses,
-- and the reasoning is the same: a role grant propagates to whoever is
-- given that role next, and nobody re-reads what a role can do when they
-- hand it out. An issue queue carries screenshots of other people's
-- customers, so that reach should follow a PERSON.
--
-- Registered as `canManageIssues` in services/feature-access.service.js.
--
-- FAIL-CLOSED: parseEmailAllowlist() turns a missing or empty value into
-- an empty Set, which denies everyone. So this seed is what switches the
-- feature on, and an environment that never runs it grants nobody —
-- including a fresh QA.
--
-- EDIT THIS LIST as the triage team changes; it is a plain CSV, and
-- services/properties.service.js caches it for 60s, so a change is live
-- within the minute without a deploy.

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'access.issues.emails', 'sundeep@easyfix.in,priyanka@easyfix.in,harkirpa@easyfix.in'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'access.issues.emails');


-- ── Verification ────────────────────────────────────────────────────
-- SELECT COUNT(*) FROM tbl_crm_issue_image;
-- SELECT COUNT(*) FROM tbl_crm_issue WHERE screenshot_key IS NOT NULL;
--   ^ the second must be <= the first; every legacy key is now a row.
-- SELECT property_value FROM easyfix_properties WHERE property_key = 'access.issues.emails';
