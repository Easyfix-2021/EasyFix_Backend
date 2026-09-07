-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-07 — RBAC seed for "Re-send Customer PIN" (admin jobs)
--
-- WHAT
--   Seeds the `isJobCustomerPinResend` menu_action under the Manage Jobs
--   menu and grants it to Admin (role 2) and Executive Supply (role 3).
--
-- WHY
--   POST /api/admin/jobs/:id/resend-customer-pin is gated by
--   requireAction('isJobCustomerPinResend') (middleware/require-action.js).
--   Without these rows the grant does not exist, getEffectivePermissions
--   never returns the key, and the endpoint 403s for EVERY role — i.e. the
--   feature is unreachable until this runs.
--
--   Roles 2 + 3 mirror the neighbouring customer-contacting action
--   `isJobMagicLinkSend` (migrations/executed/2026-05-28-magic-link-feature.sql),
--   which is the closest sibling: same menu, same "operator sends something
--   to the customer" shape. Grant more roles later via Manage Role — the
--   conservative start is easier to widen than to claw back.
--
-- HOW TO APPLY
--   Run each statement below in order. Plain INSERT / UPDATE — no prepared
--   statements, no @-variables, no PREPARE/EXECUTE. Works identically in
--   MySQL CLI, DataGrip, DBeaver, Workbench.
--
-- IDEMPOTENCY
--   Fully idempotent (NOT EXISTS guards on both inserts, soft-delete
--   reactivation on the grant). Safe to re-run.
--
-- POST-APPLY
--   Affected users log out + back in so their permissions are re-read.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The action row, under the Manage Jobs menu ───────────────────
-- Same menu lookup the magic-link seed uses (tbl_menu.url = 'job').

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'job' AND menu_status = 1 ORDER BY menu_id ASC LIMIT 1), 'isJobCustomerPinResend', 'Re-send Customer PIN (SMS)', 1, 0, NOW() WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobCustomerPinResend');


-- ─── 2. Grants: Admin (2) + Executive Supply (3) ─────────────────────
-- Reactivate any previously soft-deleted grant first, then insert the
-- ones that were never created.

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id IN (2, 3) AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isJobCustomerPinResend');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT r.role_id, ma.id, 0 FROM (SELECT 2 AS role_id UNION ALL SELECT 3) r JOIN menu_action ma ON ma.action_name = 'isJobCustomerPinResend' WHERE NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = r.role_id AND rma.menu_action_id = ma.id);


-- ─── 3. Verify (read-only) ───────────────────────────────────────────
-- granted_roles must be 2.

SELECT ma.id, ma.action_name, ma.name, ma.menu_id, (SELECT COUNT(*) FROM role_menu_action rma WHERE rma.menu_action_id = ma.id AND rma.role_id IN (2, 3) AND rma.isDeleted = 0) AS granted_roles FROM menu_action ma WHERE ma.action_name = 'isJobCustomerPinResend';
