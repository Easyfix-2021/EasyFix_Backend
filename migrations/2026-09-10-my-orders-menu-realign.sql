-- 2026-09-10 — My Orders menu: rename Audit & Complete, add Completed
--
-- Companion to the code change that realigned the job stages
-- (EasyFix_Backend lib/job-stages.js, Easyfix_CRM_UI src/lib/job-tabs.ts):
--
--     10 -> Under Audit            (was labelled "Audit & Complete")
--      3 -> Pending for Feedback
--      5 -> Completed              (new tab, needs this menu row)
--
-- The sidebar of BOTH CRMs is rendered from tbl_menu — the new CRM reads it via
-- /api/shared/lookup/menus, the legacy CRM via sp_ef_user_getuser_menuaccess_list
-- — so this file is the only place the menu can change. Nothing in either
-- codebase can do it.
--
-- ⚠ READ BEFORE RUNNING — the legacy portal is affected too.
--
--   1. Renaming menu row 53 renames it in the LEGACY sidebar as well. That is
--      harmless and arguably desirable: its url is enumDesc=PendingForCheckout,
--      which IS status 10, so "Under Audit" describes it correctly in both.
--
--   2. The new "Completed" row will ALSO appear in the legacy portal's My
--      Orders, where dashboardChecking has no result mapped for
--      enumDesc=Completed — so it would be a dead link there.
--
--      Do ONE of these first:
--        (a) add "completed" to HIDDEN_MENU_NAMES in the legacy CRM's
--            com.easyfix.util.HiddenScreens and deploy it — that hides the row
--            from the legacy sidebar only, leaving it live in the new CRM; or
--        (b) run this only once the legacy My Orders menu is retired.
--
--      Running this before either leaves a broken menu entry in the legacy CRM.
--
-- Rows are matched on `url`, never on menu_id: ids are not guaranteed identical
-- between the QA and Production schemas, and a wrong id fails SILENTLY (zero
-- rows updated, no error, nobody finds out until someone looks at the sidebar).
-- Each of these urls was verified unique in the schema.
--
-- Run once. There is no NOT EXISTS guard on the INSERT — running the file twice
-- would create a duplicate "Completed" row. Step 0 shows you the current state
-- so you can see whether it has already been applied.

-- ─── 0. Before ───────────────────────────────────────────────────────
SELECT m.menu_id, m.menu_name, m.url, m.sequence FROM tbl_menu m WHERE m.parent_menu = (SELECT s.parent_menu FROM (SELECT parent_menu FROM tbl_menu WHERE url = 'dashboardChecking?enumDesc=PendingFeedback') s) ORDER BY m.sequence;

-- ─── 1. Rename: "Audit & Complete" -> "Under Audit" ──────────────────
UPDATE tbl_menu SET menu_name = 'Under Audit' WHERE url = 'dashboardChecking?enumDesc=PendingForCheckout';

-- ─── 2. Free up sequence 3.0008 for Completed ────────────────────────
-- `sequence` is float(11,4) — only FOUR decimal places — so there is no value
-- available between Pending for Feedback (3.0007) and Orders in Follow-up
-- (3.0008): 3.00075 rounds to 3.0008 and collides. Orders in Follow-up moves
-- down one slot instead, which also keeps the three realigned entries adjacent
-- and in lifecycle order.
UPDATE tbl_menu SET sequence = 3.0009 WHERE url = 'dashboardChecking?enumDesc=PendingForApproval';

-- ─── 3. Add "Completed" ──────────────────────────────────────────────
-- parent_menu / menu_depth / icons / action_name are copied from the Pending
-- for Feedback row rather than written as literals, so this cannot drift from
-- its siblings or depend on a hardcoded parent id.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name) SELECT 'Completed', s.parent_menu, s.menu_depth, 0, 'dashboardChecking?enumDesc=Completed', 1, 3.0008, s.icons, s.action_name FROM tbl_menu s WHERE s.url = 'dashboardChecking?enumDesc=PendingFeedback' LIMIT 1;

-- ─── 4. After — expect Under Audit / Pending for Feedback / Completed ─
SELECT m.menu_id, m.menu_name, m.url, m.sequence, m.menu_status FROM tbl_menu m WHERE m.url IN ('dashboardChecking?enumDesc=PendingForCheckout', 'dashboardChecking?enumDesc=PendingFeedback', 'dashboardChecking?enumDesc=Completed', 'dashboardChecking?enumDesc=PendingForApproval') ORDER BY m.sequence;

-- ─── 5. Guard: exactly one Completed row ─────────────────────────────
SELECT 'Completed rows (expect 1)' AS check_name, COUNT(*) AS n FROM tbl_menu WHERE url = 'dashboardChecking?enumDesc=Completed';

-- AFTER RUNNING: the menu list is cached in the session at login in the legacy
-- CRM, and fetched per-session in the new CRM. Users already signed in keep the
-- old sidebar until they log in again.
--
-- ALSO: the new "Completed" row is not granted to anyone yet. tbl_user.menues is
-- a CSV of menu ids, so users only see this row once their grant includes the
-- new id printed by step 4. Add it the same way any other My Orders row is
-- granted.
