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

SELECT property_key, property_value FROM easyfix_properties WHERE property_key = 'job.charges.emails';

-- ─── 2. The action ───────────────────────────────────────────────────
-- Attached to the Finance menu: charges, penalties, travel, incentives and
-- advances are finance-shaped operations, and the sibling isInvoice*/isPayout*
-- actions already live there (migrations/executed/2026-05-26-add-finance-quotation-write-actions.sql).
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'finance' OR menu_name = 'Finance' ORDER BY menu_id ASC LIMIT 1), 'isJobChargesManage', 'Manage Job Charges (Billing & Charges tab, penalties/travel/incentives, job documents, Audit entry point)', 1, 0, NOW() FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobChargesManage');

-- ─── 3. Grant it ─────────────────────────────────────────────────────
-- Admin (2) and Finance (7). NOT granted broadly: this is the same capability
-- the allowlist intended to restrict — the change is WHERE it is administered,
-- not how tightly. Add further roles from Manage Role, which is now possible.
INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isJobChargesManage' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT 7, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isJobChargesManage' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 7 AND rma.menu_action_id = ma.id);

-- ─── 4. Verify ───────────────────────────────────────────────────────
SELECT 'action exists' AS what, COUNT(*) AS ok FROM menu_action WHERE action_name = 'isJobChargesManage'
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
