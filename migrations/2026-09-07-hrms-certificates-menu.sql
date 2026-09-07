-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-07 — HRMS: add the Certificates leaf and its action key.
--
-- Pairs with the CRM page at src/app/(authed)/hrms/certificates/page.tsx and
-- its URL_MAP entry ('hrmsCertificates' -> '/hrms/certificates'). Without that
-- map entry the sidebar link falls through to /coming-soon no matter what this
-- SQL says.
--
-- WHAT THE PAGE IS. A blank certificate template with a form beside it: fill in
-- the recipient, the training or event, the date and the signatory, and
-- download a print-quality PDF or image. It is NOT tied to any record —
-- nothing about the certificate is stored — so it issues to anyone: a
-- technician, office staff, or an external trainee who exists nowhere in this
-- database.
--
-- WHY IT IS NOT A ROW ACTION ON MANAGE USERS, and not a page under LMS.
-- An earlier draft put an "Issue Certificate" action on each user row and a
-- Certificates list under LMS. Both implied a stored thing that does not
-- exist: a per-user action reads as "this user's certificate", and a list page
-- has nothing to list. LMS course certificates already download from Training
-- Report, where the completion they attest to lives. So: one page, no list, no
-- row binding.
--
-- FOUR ARTIFACTS OR THE PAGE IS UNREACHABLE
--   1. tbl_menu leaf                        — this file
--   2. menu_action key                      — this file
--   3. role grants: tbl_role.menu_ids CSV
--      AND role_menu_action                 — this file
--   4. new.crm.visible.menu.ids property    — this file
--   plus the CRM's URL_MAP entry.
--
-- WHY A NEW KEY RATHER THAN REUSING ONE
--   Issuing a document in someone's name is its own privilege. isLmsManage
--   would tie an HRMS page to an LMS permission, which reads as a mistake in
--   Manage Roles; isUserEdit would conflate editing a colleague's record with
--   generating a certificate for a person who may not have one. Seeded to
--   Admin only — starting narrow is recoverable, and ops can widen it in
--   Manage Roles once they decide who signs these off.
--
-- SIBLING, NOT CHILD
--   Sidebar.tsx::buildTree() re-parents any grandchild to its nearest
--   top-level ancestor — the tree is a hard two levels. Certificates is a
--   SIBLING of Manage User and Approvals under HRMS.
--
-- WHY THE PROPERTY IS UPDATE-ONLY, NEVER INSERT
--   If new.crm.visible.menu.ids is absent, resolveVisibleMenuIds() returns
--   null and the allowlist is inactive — every menu shows. Creating the key
--   here would switch that filter ON for a whole environment as a side effect
--   of adding one page, hiding every menu not on the list.
--
-- POST-APPLY
--   Operators must log out and back in. menu_ids and actionPermissions are
--   resolved into the JWT at login, so a running session keeps the old set.
--
-- Steps 1 and 2 are read-only. Read them before running step 3 onward.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. What exists now (read-only) ──────────────────────────────────
SELECT menu_id, menu_name, parent_menu, menu_depth, url, sequence, menu_status FROM tbl_menu WHERE menu_id = 11 OR parent_menu = 11 ORDER BY menu_depth, sequence;


-- ─── 2. Is the leaf already here? Expect 0 rows on a first run ───────
SELECT menu_id, menu_name, parent_menu, url FROM tbl_menu WHERE url = 'hrmsCertificates';


-- ─── 3. The Certificates leaf ────────────────────────────────────────
-- Parent resolved by id. The sequence is derived from the siblings through a
-- derived table (MySQL will not let an INSERT target read the same table in a
-- plain subquery), so the leaf appends to the end of the HRMS group whatever
-- the sequences happen to be in this environment.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Certificates', p.menu_id, 2, 0, 'hrmsCertificates', 1, COALESCE((SELECT MAX(s.sequence) FROM (SELECT sequence FROM tbl_menu WHERE parent_menu = 11) s), p.sequence) + 0.0001, 'fa-circle', 'hrmsCertificates'
  FROM tbl_menu p
 WHERE p.menu_id = 11
   AND NOT EXISTS (SELECT 1 FROM tbl_menu x WHERE x.url = 'hrmsCertificates');


-- ─── 4. Action key ───────────────────────────────────────────────────
-- One key, not a view/issue pair. There is nothing to view: the page has no
-- list and no stored record, so opening it and using it are the same act.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'hrmsCertificates' LIMIT 1), 'isCertificateIssue', 'Issue Certificates', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isCertificateIssue');


-- ─── 5. Sidebar visibility — the legacy CSV on tbl_role ──────────────
-- Admin (role 2) only, deliberately. FIND_IN_SET guard makes it idempotent.
UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'hrmsCertificates')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'hrmsCertificates'), COALESCE(menu_ids, ''));


-- ─── 6. Action grant ─────────────────────────────────────────────────
-- Revive-then-insert: role_menu_action SOFT-deletes, so an insert-only
-- migration leaves a previously revoked grant revoked forever.
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isCertificateIssue');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isCertificateIssue' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);


-- ─── 7. The CRM visible-menu allowlist ───────────────────────────────
-- Append-only. No INSERT — see the header.
UPDATE easyfix_properties p JOIN tbl_menu m ON m.url = 'hrmsCertificates' SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));


-- ─── 8. Verify ───────────────────────────────────────────────────────
SELECT 'Certificates leaf present' AS what, COUNT(*) AS ok FROM tbl_menu WHERE url = 'hrmsCertificates'
UNION ALL SELECT 'leaf is depth 2 under HRMS (11)', COUNT(*) FROM tbl_menu WHERE url = 'hrmsCertificates' AND parent_menu = 11 AND menu_depth = 2
UNION ALL SELECT 'leaf sorts after every sibling', COUNT(*) FROM tbl_menu n WHERE n.url = 'hrmsCertificates' AND n.sequence > (SELECT MAX(s.sequence) FROM (SELECT sequence, url FROM tbl_menu WHERE parent_menu = 11) s WHERE s.url <> 'hrmsCertificates')
UNION ALL SELECT 'action key seeded', COUNT(*) FROM menu_action WHERE action_name = 'isCertificateIssue'
UNION ALL SELECT 'key hangs off the Certificates leaf', COUNT(*) FROM menu_action ma JOIN tbl_menu m ON m.menu_id = ma.menu_id WHERE ma.action_name = 'isCertificateIssue' AND m.url = 'hrmsCertificates'
UNION ALL SELECT 'admin holds the key', COUNT(*) FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND ma.action_name = 'isCertificateIssue'
UNION ALL SELECT 'admin sees the leaf', COUNT(*) FROM tbl_role r JOIN tbl_menu m ON m.url = 'hrmsCertificates' WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, ''))
UNION ALL SELECT 'allowlist carries it (0 = allowlist inactive, also fine)', COUNT(*) FROM easyfix_properties p JOIN tbl_menu m ON m.url = 'hrmsCertificates' WHERE p.property_key = 'new.crm.visible.menu.ids' AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));
