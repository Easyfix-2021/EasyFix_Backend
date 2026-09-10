-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-10 — otp_details: one row per (user_email, user_mobile_no, otp_type)
--
-- WHY
--   The login-OTP flow has always intended a single row per that tuple —
--   services/auth.service.js refreshes an existing row rather than appending.
--   Nothing enforced it, so when the lookup broke (2026-09-10: `user_mobile_no
--   = ?` bound to NULL is never true, so it missed the row it had just
--   written) every login request appended another row and nobody found out
--   until a user could not log in. An index would have turned a silent
--   accumulation into a loud failure at the second INSERT.
--
-- ⚠ READ THIS BEFORE YOU RELY ON IT — IT DOES NOT COVER THE CASE THAT BROKE
--   InnoDB treats NULLs in a UNIQUE index as DISTINCT, so this index does NOT
--   stop duplicate rows when a column is NULL — and all three columns are
--   nullable today. Measured on QA, not assumed:
--
--     CREATE TEMPORARY TABLE p (..., UNIQUE KEY uq (user_email, user_mobile_no, otp_type));
--     INSERT ('varun@easyfix.in', NULL,          'crm_login');  -- ok
--     INSERT ('varun@easyfix.in', NULL,          'crm_login');  -- ALSO OK → 2 rows
--     INSERT ('x@y.in',           '9810833037',  'crm_login');  -- ok
--     INSERT ('x@y.in',           '9810833037',  'crm_login');  -- ER_DUP_ENTRY 1062
--
--   So for Varun — email set, mobile NULL — this index would have permitted
--   every duplicate it was meant to prevent. It protects the majority case
--   (users who have a mobile) and nothing else.
--
--   To make it total, user_email / user_mobile_no / otp_type would have to
--   become NOT NULL DEFAULT '' — and that is a nullability change on a table
--   shared with five legacy services (see CLAUDE.md "Shared DB"), which can
--   change how THEIR queries behave (`WHERE user_mobile_no IS NULL` stops
--   matching). Not done here. It is a decision, not a cleanup.
--
--   The actual defence is in the code: both lookups now use <=> (null-safe
--   equality) and ORDER BY generated_on DESC. This index is a belt to that
--   brace, not a replacement for it.
--
-- HOW TO APPLY
--   Sections in order. Section 1 is read-only — run it first and look. Plain
--   DELETE / ALTER, one statement per line, no @-variables, no PREPARE.
--
-- IDEMPOTENCY
--   Section 2 is idempotent (a second run deletes nothing). Section 3 is NOT:
--   re-running it errors with ER_DUP_KEYNAME, which is safe and self-
--   announcing. Section 4 is read-only.
--
-- APPLIED
--   Executed 2026-09-10 by Harshit; this file then moved to
--   migrations/executed/ and is FROZEN.
--
--   ⚠ WHAT IS AND IS NOT NOW ENFORCED. The unique index is in place, so a
--   duplicate (email, mobile, otp_type) with NO NULLs is rejected 1062. Rows
--   where ANY of the three is NULL are STILL duplicable — InnoDB treats NULLs
--   in a unique index as distinct, proven on a temp table before this shipped.
--   The user who reported the outage (email set, mobile NULL) is in that
--   uncovered set, so his protection is entirely the <=> lookup in
--   services/auth.service.js — not this index. Do not read "unique index
--   exists" as "duplicates are impossible".
--
--   To change that, the columns would need NOT NULL DEFAULT '' on a table five
--   legacy services share. Still an open decision; it belongs in a NEW dated
--   migration, never here.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. Look first (read-only) ───────────────────────────────────────
-- How many tuples are duplicated, and how many rows section 2 would remove.
-- If rows_to_remove is 0, skip section 2 entirely.

SELECT COUNT(*) AS duplicate_tuples, COALESCE(SUM(n) - COUNT(*), 0) AS rows_to_remove FROM (SELECT COUNT(*) AS n FROM otp_details GROUP BY user_email, user_mobile_no, otp_type HAVING COUNT(*) > 1) d;

-- The exact rows that would go, newest kept. Eyeball this before deleting.

SELECT t.id, t.user_email, t.user_mobile_no, t.otp_type, t.otp, t.generated_on, t.is_expired FROM otp_details t JOIN otp_details k ON k.otp_type <=> t.otp_type AND k.user_email <=> t.user_email AND k.user_mobile_no <=> t.user_mobile_no AND k.id > t.id ORDER BY t.user_email, t.id;


-- ─── 2. Keep the newest row per tuple ────────────────────────────────
-- Deletes any row that has a higher-id sibling in the same tuple, so exactly
-- the highest id survives. Keyed on id rather than generated_on because id is
-- AUTO_INCREMENT (so it is insertion order, which is what duplicates are) and
-- because generated_on is nullable — a NULL there would make a > comparison
-- NULL and silently protect the row from cleanup.
--
-- ⚠ The join uses <=>, not =. With `=` the NULL-mobile groups would not match
-- themselves and this cleanup would silently skip the very rows it exists to
-- remove — the same mistake that caused the outage, repeated in its fix.

DELETE t FROM otp_details t JOIN otp_details k ON k.otp_type <=> t.otp_type AND k.user_email <=> t.user_email AND k.user_mobile_no <=> t.user_mobile_no AND k.id > t.id;


-- ─── 3. Enforce it going forward ─────────────────────────────────────
-- Fails with ER_DUP_ENTRY if section 2 was skipped while duplicates existed.
-- That is the correct outcome: do not weaken the index, remove the duplicates.

ALTER TABLE otp_details ADD UNIQUE INDEX uq_otp_email_mobile_type (user_email, user_mobile_no, otp_type);


-- ─── 4. Verify (read-only) ───────────────────────────────────────────
-- Expected: index_present = 1, non_unique = 0, duplicate_tuples = 0.
-- Note duplicate_tuples counts only tuples with NO NULLs; NULL-bearing
-- duplicates remain possible by design (see the warning at the top) and are
-- prevented by the application's <=> lookup, not by this index.

SELECT COUNT(DISTINCT INDEX_NAME) AS index_present, MIN(NON_UNIQUE) AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'otp_details' AND INDEX_NAME = 'uq_otp_email_mobile_type';

SELECT COUNT(*) AS duplicate_tuples FROM (SELECT COUNT(*) AS n FROM otp_details WHERE user_email IS NOT NULL AND user_mobile_no IS NOT NULL AND otp_type IS NOT NULL GROUP BY user_email, user_mobile_no, otp_type HAVING COUNT(*) > 1) d;
