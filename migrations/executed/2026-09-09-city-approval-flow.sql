-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-09 — New-City approval flow (Manage Cities)
--
-- WHY
--   Six code paths create a tbl_city row automatically, three of them
--   reachable without any CRM login (public website booking, the technician
--   magic-link profile form, and AI transcript extraction). Every one of them
--   inserts city_status = 1 — LIVE the instant it is written — so a city can
--   enter the system with nobody deciding it should exist and no technician
--   covering it. Operators found several in production (city_id 11172, 11213,
--   11235) and could only react after the fact.
--
--   This adds the state that lets those paths keep working without the city
--   going live: they now create it PENDING, and Manage Cities approves or
--   rejects it.
--
-- THE SENTINEL — no DDL needed for it
--   tbl_city.city_status is already `tinyint NULL DEFAULT 1` and today holds
--   only 0 and 1. PENDING is the value 2. This mirrors the established
--   precedent in services/entity-deletion.service.js, where DELETED_STATUS = 3
--   is a status sentinel on a shared legacy table rather than a new column.
--
--     0 = inactive (operator deactivated, or a rejected city after its data
--         has been merged into the replacement)
--     1 = active
--     2 = pending approval   ← NEW
--
--   ⚠ READ THIS BEFORE ADDING A QUERY. ~160 places read tbl_city and most do
--   NOT filter city_status — correctly, because they JOIN to resolve the NAME
--   of a city a row already points at, and a saved job must keep showing its
--   city even after that city is deactivated. Only SELECTION surfaces (where a
--   city is offered for choosing, or resolved for a NEW record) filter on
--   city_status = 1. Adding the filter to a name-resolution JOIN is a bug, not
--   a hardening.
--
-- HOW TO APPLY
--   Run each statement below in order. Plain ALTER / INSERT / UPDATE — no
--   prepared statements, no @-variables, no PREPARE/EXECUTE. Works identically
--   in MySQL CLI, DataGrip, DBeaver, Workbench.
--
-- IDEMPOTENCY
--   Section 1 is NOT idempotent — MySQL has no ADD COLUMN IF NOT EXISTS (that
--   is MariaDB). Re-running section 1 errors with ER_DUP_FIELDNAME, which is
--   safe and self-announcing; skip it if the columns already exist. Sections 2
--   and 3 are fully idempotent (NOT EXISTS guards + soft-delete reactivation).
--
-- POST-APPLY
--   Affected users log out and back in so their permissions are re-read
--   (services/role.service.js caches per user).
--
--   RESTART THE BACKEND PROCESS TOO. services/city.service.js and
--   services/pincode.service.js memoise `SHOW COLUMNS` probes for these
--   columns in module scope. A process that started BEFORE this migration has
--   cached "absent" and will keep the approval audit and the merge-pointer
--   forwarding switched off until it is restarted — silently, because absent
--   is a legitimate answer that degrades rather than errors.
--
-- APPLIED
--   QA (10.30.2.30 / easyfix): 2026-09-09. menu_action id 103 under menu_id 14
--   (Manage Cities), granted to roles 2 / 13 / 15.
--   Production: 2026-09-09, applied by Harshit. This file then moved to
--   migrations/executed/ and is FROZEN — any further change to these columns
--   or grants goes in a NEW dated migration, never here.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. Approval audit on tbl_city ───────────────────────────────────
-- Who decided, when, and — for a rejection — where the rejected city's rows
-- were merged to. That last column is the important one: rejection reassigns
-- references across nine tables, and without it there is no way afterwards to
-- answer "this address used to be city X, where did it go".

ALTER TABLE tbl_city ADD COLUMN approved_by INT NULL;
ALTER TABLE tbl_city ADD COLUMN approved_at DATETIME NULL;
ALTER TABLE tbl_city ADD COLUMN approval_decision VARCHAR(10) NULL;
ALTER TABLE tbl_city ADD COLUMN merged_into_city_id INT NULL;

-- Pending cities are listed by status and ordered by age; without this the
-- Manage Cities pending tab scans a 11k-row table on every poll.
ALTER TABLE tbl_city ADD INDEX idx_city_status_created (city_status, created_date);


-- ─── 2. The approve/reject permission ────────────────────────────────
-- Menu lookup by url, exactly as the neighbouring seeds do — Manage Cities is
-- tbl_menu.url = 'city' (menu_id 14 on QA, but never hard-code the id).

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'city' AND menu_status = 1 ORDER BY menu_id ASC LIMIT 1), 'isCityApprove', 'Approve / Reject New City', 1, 0, NOW() WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isCityApprove');


-- ─── 3. Grants: mirror isCityEdit ────────────────────────────────────
-- isCityEdit is held by Admin (2), Project Manager (13) and Admin Supply (15).
-- Approving a new city is the same menu and the same "who curates the city
-- master" question, so it mirrors its closest sibling rather than inventing a
-- narrower set. Widen or narrow later via Manage Role.

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id IN (2, 13, 15) AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isCityApprove');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT r.role_id, ma.id, 0 FROM (SELECT 2 AS role_id UNION ALL SELECT 13 UNION ALL SELECT 15) r JOIN menu_action ma ON ma.action_name = 'isCityApprove' WHERE NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = r.role_id AND rma.menu_action_id = ma.id);


-- ─── 4. Verify (read-only) ───────────────────────────────────────────
-- Expected: granted_roles = 3, approval_cols_present = 4,
-- pending_index_present = 1.
--
-- ⚠ pending_index_present uses COUNT(DISTINCT INDEX_NAME). information_schema
-- .STATISTICS holds ONE ROW PER COLUMN PER INDEX, and this index has two
-- columns — so a plain COUNT(*) returns 2 and reads as "something is wrong"
-- when everything is right. Caught applying this to QA on 2026-09-09.

SELECT ma.id, ma.action_name, ma.name, ma.menu_id, (SELECT COUNT(*) FROM role_menu_action rma WHERE rma.menu_action_id = ma.id AND rma.role_id IN (2, 13, 15) AND rma.isDeleted = 0) AS granted_roles FROM menu_action ma WHERE ma.action_name = 'isCityApprove';

SELECT COUNT(*) AS approval_cols_present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_city' AND COLUMN_NAME IN ('approved_by', 'approved_at', 'approval_decision', 'merged_into_city_id');

SELECT COUNT(DISTINCT INDEX_NAME) AS pending_index_present FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_city' AND INDEX_NAME = 'idx_city_status_created';
