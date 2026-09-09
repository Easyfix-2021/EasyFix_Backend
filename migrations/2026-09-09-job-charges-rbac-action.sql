-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-09 — Billing & Charges moves from an email allowlist to RBAC.
--
-- REPORTED: "Still can't see any action other than View in Audit & Complete."
--
-- WHY. canManageJobCharges gated the Billing & Charges tab, its two route
-- groups, and the Audit entry point added on 2026-09-08. It resolved from
-- easyfix_properties['job.charges.emails'] — a CSV of addresses held
-- deliberately OUTSIDE menu_action, with this rationale in
-- services/feature-access.service.js:
--
--     "these features carry no menu_action row, they can NEVER appear in
--      (or be granted from) the Manage Role screen — the easyfix_properties
--      value is the SOLE gate."
--
-- No migration ever seeded that property, and emailAllowed() returns false for
-- an unset key. So the tab was invisible to EVERY user from the day it shipped
-- (2026-07-28), every /admin/jobs/:id/charges and /documents route 403'd for
-- everyone, and the property's own design meant no screen could grant access.
--
-- The rationale for keeping it out of RBAC was that these capabilities are
-- exceptional. Managing a job's charges is not exceptional — it is ordinary
-- Finance work, it belongs on a role, and the operator asked for it to be
-- managed from roles only.
--
-- The FE flag name does NOT change: three CRM files and the profile screen read
-- `me.canManageJobCharges`, and only its resolution moves.
--
-- MINIMAL STYLE per feedback_easyfix_minimal_migration_style: one statement per
-- line, no @set, no PREPARE, no MariaDB-only syntax. The menu is located by
-- subquery inline so a missing menu yields a NULL insert that fails loudly
-- rather than a silently skipped grant.
-- ─────────────────────────────────────────────────────────────────────

-- ─── 1. What exists now (read-only) ──────────────────────────────────
SELECT menu_id, menu_name, url FROM tbl_menu WHERE url = 'finance' OR menu_name = 'Finance' ORDER BY menu_id ASC;

SELECT id, menu_id, action_name, name, status FROM menu_action WHERE action_name = 'isJobChargesManage';

-- The width of `name`, because the first version of this migration failed with
-- "Data truncation: Data too long for column 'name'" on a 104-character label.
-- The JPA entity (EasyFix_CRM MenuAction.java) declares no length, so it reads
-- as the 255 default and is not the authority; information_schema is.
SELECT CHARACTER_MAXIMUM_LENGTH AS name_max_chars FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu_action' AND COLUMN_NAME = 'name';

SELECT property_key, property_value FROM easyfix_properties WHERE property_key = 'job.charges.emails';

-- ─── 2. The action ───────────────────────────────────────────────────
-- NAME IS SHORT ON PURPOSE. The first attempt used a 104-character label
-- describing everything the action unlocks and was rejected: menu_action.name
-- is narrower than that. The longest label in the live table is 70 characters
-- ("Secrets Manager — Re-Key Encrypted Fields (Rotate / Recover / Re-Seal)"), so
-- the limit sits between 71 and 103; step 1 above prints the exact figure. This
-- one is 30 characters, which is the length siblings actually use — the detail
-- belongs in this comment, not in a column that has to render in a role picker.
--
-- Attached to the Finance menu: charges, penalties, travel, incentives and
-- advances are finance-shaped operations, and the sibling isInvoice*/isPayout*
-- actions already live there (migrations/executed/2026-05-26-add-finance-quotation-write-actions.sql).
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'finance' OR menu_name = 'Finance' ORDER BY menu_id ASC LIMIT 1), 'isJobChargesManage', 'Manage Job Charges & Documents', 1, 0, NOW() FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobChargesManage');

-- ─── 3. Grant it ─────────────────────────────────────────────────────
-- Admin (2) and Finance (7). NOT granted broadly: this is the same capability
-- the allowlist intended to restrict — the change is WHERE it is administered,
-- not how tightly. Add further roles from Manage Role, which is now possible.
INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isJobChargesManage' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT 7, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isJobChargesManage' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 7 AND rma.menu_action_id = ma.id);

-- ─── 4. Verify ───────────────────────────────────────────────────────
SELECT 'action exists' AS what, COUNT(*) AS ok FROM menu_action WHERE action_name = 'isJobChargesManage'
UNION ALL SELECT 'name fits the column', COUNT(*) FROM menu_action ma JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = 'menu_action' AND c.COLUMN_NAME = 'name' WHERE ma.action_name = 'isJobChargesManage' AND CHAR_LENGTH(ma.name) <= c.CHARACTER_MAXIMUM_LENGTH
UNION ALL SELECT 'attached to a real menu', COUNT(*) FROM menu_action ma JOIN tbl_menu m ON m.menu_id = ma.menu_id WHERE ma.action_name = 'isJobChargesManage'
UNION ALL SELECT 'granted to Admin (2)', COUNT(*) FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE ma.action_name = 'isJobChargesManage' AND rma.role_id = 2 AND rma.isDeleted = 0
UNION ALL SELECT 'granted to Finance (7)', COUNT(*) FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE ma.action_name = 'isJobChargesManage' AND rma.role_id = 7 AND rma.isDeleted = 0;

-- ─── 5. The old gate is now inert ────────────────────────────────────
-- Left in place rather than deleted: it is read by nothing after this deploy,
-- and an easyfix_properties row is cheap. Deleting it would make a rollback of
-- the code change silently deny everyone again, which is the failure this
-- migration exists to end.
SELECT 'job.charges.emails is now unread by code' AS note, COUNT(*) AS rows_left FROM easyfix_properties WHERE property_key = 'job.charges.emails';

-- AFTER RUNNING: users must log out and back in. canManageJobCharges is
-- resolved at /auth/me, so a live session keeps its old answer until it
-- re-fetches.
