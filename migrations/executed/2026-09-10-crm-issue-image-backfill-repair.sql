-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-10 — Re-run the issue-screenshot backfill AFTER the v2 code is
-- deployed. RUN THIS ON EVERY ENVIRONMENT, AFTER the deploy, NOT BEFORE.
--
-- ── WHY THIS FILE EXISTS ────────────────────────────────────────────
-- executed/2026-09-10-crm-issue-reporter-v2.sql was applied to Production
-- while Production was still running the V1 CODE, and it still is: at the
-- time of writing origin/Production and origin/QA are both pinned at
-- 0afb837, which predates ce5c57a (the commit that stops writing
-- tbl_crm_issue.screenshot_key and starts writing tbl_crm_issue_image).
--
-- So there is a WINDOW, and in it the two halves disagree:
--
--   v1 code  + v2 schema  →  a new issue with a screenshot writes
--                            tbl_crm_issue.screenshot_key and NO image row.
--   v2 code  reads images only  →  that screenshot becomes INVISIBLE the
--                            moment the deploy lands.
--
-- The v2 backfill already ran, so it cannot help those rows: it is a
-- one-shot INSERT ... SELECT, and every issue created after it ran is
-- outside the set it copied. Nothing errors. The issue keeps its title,
-- its description and its thread, and simply shows no screenshot — which
-- reads as "the reporter did not attach one", the one failure mode that
-- looks exactly like normal.
--
-- THE ORDERING IS NOT INTERCHANGEABLE, in either direction:
--   SQL before code (what happened on Production) → screenshots stranded,
--       silently. This file repairs that.
--   CODE before SQL (the QA risk today) → createIssue's image INSERT hits a
--       table that does not exist. It is deliberately NOT in a transaction
--       with the parent INSERT (see services/issue.service.js), so the
--       issue row lands and the request then 500s, and the list and detail
--       endpoints 500 too because both project from tbl_crm_issue_image.
--       QA has NOT had v2 applied — verified by probe on 2026-09-10:
--       tbl_crm_issue_image absent, access.issues.emails absent. QA must
--       get executed/2026-09-10-crm-issue-reporter-v2.sql BEFORE ce5c57a
--       reaches it.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────
-- Exactly the v2 backfill statement again. It is idempotent by the
-- NOT EXISTS: an issue that already has any image row is skipped, so a
-- re-run copies nothing twice, and running it on an environment with no
-- stranded rows affects 0 rows and is a no-op.
--
-- Safe to run more than once. Safe to run on an environment that never had
-- the problem. NOT safe to run BEFORE the v2 code deploys — v1 keeps
-- writing screenshot_key, so you would just have to run it again.
--
-- Style: plain one-statement-per-line; idempotent (re-run = no-op).

INSERT INTO tbl_crm_issue_image (issue_id, s3_key, sort_order, created_on)
SELECT i.id, i.screenshot_key, 0, i.created_on
  FROM tbl_crm_issue i
 WHERE i.screenshot_key IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tbl_crm_issue_image x WHERE x.issue_id = i.id);


-- ── Verification ────────────────────────────────────────────────────
-- This must return 0. Any row it returns is an issue whose screenshot the
-- CRM cannot show:
--
--   SELECT i.id, i.created_on
--     FROM tbl_crm_issue i
--    WHERE i.screenshot_key IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM tbl_crm_issue_image x WHERE x.issue_id = i.id);
--
-- And this is the size of the window, for the record — how many issues were
-- reported with a screenshot while the two halves disagreed:
--
--   SELECT COUNT(*) FROM tbl_crm_issue WHERE screenshot_key IS NOT NULL;
