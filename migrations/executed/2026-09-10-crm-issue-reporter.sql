-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-10 — In-app issue reporter for the CRM.
--
-- WHAT: any CRM user can report a problem from the page they are on — a
-- title, a description, the page they were looking at, and optionally a
-- screenshot. An issue manager triages the queue, comments on it, and closes
-- it with a note. Two tables, one action key.
--
-- SHARED-DB RULE — THIS IS THE DOCUMENTED EXCEPTION
--   CLAUDE.md forbids altering the shared `easyfix_core` schema. Its stated
--   carve-out is an EASYFIX-OWNED NEW TABLE THAT NO LEGACY SERVICE REFERENCES,
--   already used by tbl_pincode (2026-05-01), tbl_user_allowed_stages
--   (2026-07-29), tbl_user_personal_details (2026-08-03),
--   tbl_easyfixer_sensitive_change_log (2026-08-17), tbl_sensitive_reveal_log
--   (2026-09-01) and tbl_job_permission_request (2026-09-07). Verified before
--   writing this file: `grep -rn "tbl_crm_issue" migrations/ services/ routes/
--   validators/ tests/` → 0 hits. Both tables are written and read by
--   services/issue.service.js in this backend and by nothing legacy. NOTHING
--   existing is altered by this file.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- title           One-line summary as the reporter typed it.
-- description     The body. VARCHAR(4000), not TEXT — it is a bug report, not
--                 a document, and an inline column keeps the list query off
--                 the overflow pages.
-- page_path       The CRM route the reporter was on, PATHNAME ONLY. The query
--                 string is stripped at the validator (validators/
--                 issue.validator.js) and never reaches this column: query
--                 strings in this CRM carry job and client ids, and an issue
--                 queue readable by every issue manager must not become a
--                 side-channel listing which jobs a user was looking at.
--                 NULL when the reporter's client did not send one.
-- screenshot_key  S3 key under the `Issues/` prefix, e.g.
--                 `Issues/1757500000000_a4b9c0d2`. NO file extension — the
--                 real MIME rides on the object's Content-Type, the ops
--                 convention every other prefix here follows (utils/
--                 s3-storage.js). NULL when no screenshot was attached, and
--                 NULL for every issue created while S3 is unconfigured.
--                 NEVER returned by the list endpoint — see the service.
-- status          'open' | 'closed'. VARCHAR, not ENUM, deliberately: a third
--                 state ('triaged', 'wontfix') must not require an ALTER on a
--                 schema the shared-DB rule says we should stop touching. Same
--                 reasoning as tbl_job_permission_request.status (2026-09-07).
-- reported_by     tbl_user.user_id of the reporter. NOT NULL — an issue with
--                 no reporter has no owner, and ownership is what the read
--                 guard resolves against. No FK to tbl_user: that is a legacy
--                 table, and a tbl_user write must never be blockable by this
--                 one.
-- created_on      DATETIME written by the app as new Date(); the pool's
--                 +05:30 session timezone (db.js) stores the IST wall clock
--                 verbatim. NO DEFAULT CURRENT_TIMESTAMP — the container clock
--                 is UTC, so a DB-side default would silently mix two
--                 timezones into one column and nothing would report it (same
--                 reasoning as executed/2026-08-03-create-tbl-user-personal-
--                 details.sql and 2026-09-07-create-tbl-job-permission-
--                 request.sql).
-- closed_by       tbl_user.user_id of the manager who closed it. NULL while
--                 open. Same no-FK-to-legacy rule as reported_by.
-- closed_on       When it was closed. NULL while open. Same new Date() / IST
--                 rule as created_on.
-- close_note      Why it was closed / what was done. NULL while open.
--
-- INDEXES
--   idx_crm_issue_reported_by (reported_by) — serves `scope=mine`, which is
--                        `WHERE reported_by = ? ORDER BY id DESC`. An InnoDB
--                        secondary key already carries the PK as its trailing
--                        column, so (reported_by) IS (reported_by, id)
--                        physically and the ORDER BY is satisfied by the
--                        index; declaring (reported_by, id) would add nothing
--                        but bytes.
--   idx_crm_issue_status (status) — serves the `?status=open|closed` filter on
--                        the manager's `scope=all` queue.
--   The detail lookup (`WHERE id = ?`) rides the PK.
--
-- THE ONE FOREIGN KEY, AND WHY IT IS ALLOWED HERE
--   tbl_crm_issue_comment.issue_id → tbl_crm_issue.id, ON DELETE CASCADE.
--   Both sides are new and EasyFix-owned, so this constraint can never block a
--   legacy service's write — which is the entire reason the shared-DB rule
--   bans FKs. The precedent is the same shape: fk_course_videos_course
--   (executed/2026-08-13-lms-foundation.sql) and fk_reward_claims_item
--   (executed/2026-08-13-rewards-foundation.sql), both new→new. 9 of the 213
--   migration files declare a FOREIGN KEY and every one of them is new→new.
--
-- HOW TO APPLY
--   Run each statement in order. One statement per line, no @-variables, no
--   PREPARE/EXECUTE, nothing MariaDB-specific — works identically in MySQL
--   CLI, DataGrip, DBeaver and Workbench.
--
-- IDEMPOTENCY
--   Fully re-runnable: both CREATEs are IF NOT EXISTS and every seed write is
--   NOT EXISTS guarded. Steps 1 and 2 are read-only; read them before running
--   step 3 onward.
--
-- POST-APPLY
--   Operators must log out and back in — actionPermissions are resolved at
--   login, so a running session keeps the old set.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. Dry run: do the tables already exist? (read-only) ────────────
-- Zero rows = a fresh apply. Two rows = a re-run, and the CREATEs below are
-- no-ops via IF NOT EXISTS.
SELECT table_name, engine, table_rows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('tbl_crm_issue', 'tbl_crm_issue_comment');


-- ─── 2. Dry run: the hub leaf this key attaches to (read-only) ───────
-- Expect AT LEAST one row. This looks for BOTH tokens because the CRM's
-- URL_MAP points 'adminAction' AND 'generateClientInvoice' at /admin-actions,
-- and which one an environment actually carries is not knowable from here — QA
-- carries 'generateClientInvoice' (menu 42, named 'Admin Action'). This is not
-- a hypothetical: the first draft of executed/2026-09-01-hrms-07-rekey-rbac.sql
-- matched only 'adminAction', so its INSERT ... SELECT matched no rows,
-- inserted nothing, and REPORTED SUCCESS. Zero rows here means neither token is
-- seeded on this host and steps 4-5 will insert nothing — fix that first, or
-- the action has nowhere to live.
SELECT menu_id, menu_name, parent_menu, menu_depth, url, menu_status FROM tbl_menu WHERE url IN ('adminAction', 'generateClientInvoice');

-- Is the key already here? Expect 0 rows on a first run.
SELECT id, menu_id, action_name, name, status, delete_status FROM menu_action WHERE action_name = 'isIssueManage';

-- The width of `name`, because a previous migration failed with
-- "1406 Data truncation: Data too long for column 'name'" on a 104-character
-- label (executed/2026-09-09-job-charges-rbac-action.sql). The JPA entity
-- (EasyFix_CRM MenuAction.java) declares no length, so it reads as the 255
-- default and is NOT the authority; information_schema is. The label seeded
-- below is 22 characters, comfortably under any plausible answer, but read the
-- number before trusting that.
SELECT CHARACTER_MAXIMUM_LENGTH AS name_max_chars FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu_action' AND COLUMN_NAME = 'name';


-- ─── 3. The tables ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tbl_crm_issue (
  id             INT NOT NULL AUTO_INCREMENT,
  title          VARCHAR(200) NOT NULL,
  description    VARCHAR(4000) NOT NULL,
  page_path      VARCHAR(255) NULL DEFAULT NULL,
  screenshot_key VARCHAR(255) NULL DEFAULT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'open',
  reported_by    INT NOT NULL,
  created_on     DATETIME NOT NULL,
  closed_by      INT NULL DEFAULT NULL,
  closed_on      DATETIME NULL DEFAULT NULL,
  close_note     VARCHAR(1000) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_crm_issue_reported_by (reported_by),
  KEY idx_crm_issue_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tbl_crm_issue_comment (
  id           INT NOT NULL AUTO_INCREMENT,
  issue_id     INT NOT NULL,
  comment_text VARCHAR(2000) NOT NULL,
  commented_by INT NOT NULL,
  created_on   DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_crm_issue_comment_issue (issue_id),
  CONSTRAINT fk_crm_issue_comment_issue FOREIGN KEY (issue_id) REFERENCES tbl_crm_issue (id) ON DELETE CASCADE
) ENGINE=InnoDB;


-- ─── 4. The action key ───────────────────────────────────────────────
-- ONE key, not two. 'isIssueManage' means "triage the queue": read any issue,
-- comment on any issue, close any issue, and list with scope=all. There is
-- deliberately no separate view/close split — a grant that let someone read
-- every issue but close none produces a reviewer who cannot finish the job,
-- and REPORTING an issue needs no key at all (every CRM user may do it, and
-- may read and comment on their own without any grant).
--
-- NAME IS SHORT ON PURPOSE — see the column-width note in step 2. 22 chars.
--
-- Driven off tbl_menu rather than a scalar subquery, so a host missing the hub
-- leaf inserts NOTHING instead of inserting a key with a NULL menu_id that
-- Manage Roles could never display.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isIssueManage', 'Manage Reported Issues', 1, 0, NOW() FROM tbl_menu m WHERE m.url IN ('adminAction', 'generateClientInvoice') AND NOT EXISTS (SELECT 1 FROM menu_action ma WHERE ma.action_name = 'isIssueManage');


-- ─── 5. Grant it to Admin (role_id 2) — revive, then insert ──────────
-- role_menu_action SOFT-deletes. An insert-only seed would silently leave a
-- previously revoked grant revoked forever, so the revive runs first — the
-- same order executed/2026-09-01-hrms-07-rekey-rbac.sql uses for this hub.
-- On a first run the UPDATE matches nothing (the key was created one statement
-- ago and no grant can reference it yet); it earns its place on a re-run.
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isIssueManage');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isIssueManage' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);


-- ─── 6. Verify — every `ok` column must read 1 ───────────────────────
SELECT 'tbl_crm_issue exists' AS what, COUNT(*) AS ok FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'tbl_crm_issue'
UNION ALL SELECT 'tbl_crm_issue_comment exists', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'tbl_crm_issue_comment'
UNION ALL SELECT 'created_on has NO db-side default', COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tbl_crm_issue' AND column_name = 'created_on' AND column_default IS NULL AND extra NOT LIKE '%DEFAULT_GENERATED%'
UNION ALL SELECT 'status is VARCHAR not ENUM', COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tbl_crm_issue' AND column_name = 'status' AND data_type = 'varchar'
UNION ALL SELECT 'comment FK points at tbl_crm_issue', COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'fk_crm_issue_comment_issue' AND referenced_table_name = 'tbl_crm_issue'
UNION ALL SELECT 'action exists', COUNT(*) FROM menu_action WHERE action_name = 'isIssueManage'
UNION ALL SELECT 'name fits the column', COUNT(*) FROM menu_action ma JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = 'menu_action' AND c.COLUMN_NAME = 'name' WHERE ma.action_name = 'isIssueManage' AND CHAR_LENGTH(ma.name) <= c.CHARACTER_MAXIMUM_LENGTH
UNION ALL SELECT 'attached to a real menu', COUNT(*) FROM menu_action ma JOIN tbl_menu m ON m.menu_id = ma.menu_id WHERE ma.action_name = 'isIssueManage'
UNION ALL SELECT 'granted to Admin (2)', COUNT(*) FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE ma.action_name = 'isIssueManage' AND rma.role_id = 2 AND rma.isDeleted = 0;

-- Both index checks separately, because the query above is one row per fact
-- and these are two rows per table.
SELECT index_name, seq_in_index, column_name, non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name IN ('tbl_crm_issue', 'tbl_crm_issue_comment') ORDER BY table_name, index_name, seq_in_index;


-- ─── Hand verification once the feature is live (read-only) ──────────
--
-- 1. The open queue, oldest first — what nobody has answered yet:
-- SELECT i.id, i.title, i.page_path, i.created_on, u.user_name AS reported_by FROM tbl_crm_issue i LEFT JOIN tbl_user u ON u.user_id = i.reported_by WHERE i.status = 'open' ORDER BY i.created_on ASC;
--
-- 2. Turnaround — how long a reporter waits for a close:
-- SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR, created_on, closed_on))) AS avg_hours, COUNT(*) AS closed FROM tbl_crm_issue WHERE closed_on IS NOT NULL;
--
-- 3. Which pages generate issues — the point of storing page_path at all:
-- SELECT page_path, COUNT(*) AS reports FROM tbl_crm_issue WHERE page_path IS NOT NULL GROUP BY page_path ORDER BY reports DESC LIMIT 20;
--
-- 4. No page_path may carry a query string. MUST return zero rows — a row here
--    means the validator's strip was bypassed and job/client ids are leaking
--    into a queue every issue manager can read:
-- SELECT id, page_path FROM tbl_crm_issue WHERE page_path LIKE '%?%' OR page_path LIKE '%#%';
--
-- 5. Every closed row must carry both a closer and a time; no open row may.
--    Both counts should be zero:
-- SELECT SUM(status = 'closed' AND (closed_by IS NULL OR closed_on IS NULL)) AS closed_without_closer, SUM(status = 'open' AND closed_on IS NOT NULL) AS open_with_closed_on FROM tbl_crm_issue;
