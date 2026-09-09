-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-09 — Serviceable-pincode recompute cron: the missing switch
--
-- WHY THIS FILE EXISTS
--   server/scheduler.js registers `pincode-serviceable-recompute` behind
--   getProperty('pincode.serviceable_recompute.enabled') === 'true', and that
--   key was never created in easyfix_properties. getProperty returns undefined
--   for a key with no row, so the gate read false, the job logged SKIPPED, and
--   there was no row for an operator to flip — the switch was documented in a
--   skipReason that pointed at a property that did not exist.
--
--   Same shape as migrations/2026-08-18-rewards-earn-lookback-property.sql
--   ("referenced in code but never created in easyfix_properties"). A gate and
--   the row it reads are ONE change; shipping the gate alone produces a feature
--   that is off with no way to turn it on.
--
-- WHAT THE JOB DOES
--   tbl_pincode.pincode_status = 1 means "covered by at least one ACTIVE,
--   VERIFIED technician". Creation now computes that honestly, but coverage
--   CHANGES afterwards — a technician is verified, edits their work area, or is
--   deactivated — and recomputeServiceableStatus is the only code that
--   reconciles the flag with reality. Its sole other caller is the manual
--   Refresh Status button in Manage Pincodes. Without the schedule the flag
--   drifts in both directions and nobody notices: a pincode a technician
--   started covering stays Non-Serviceable, and the public serviceability
--   endpoint repeats that to customers.
--
-- SEEDED 'true' — this ENABLES a nightly job
--   Requested 2026-09-09. Note what is being switched on: at 03:45 IST the job
--   UPDATEs the whole tbl_pincode table twice inside one transaction, so it
--   holds a table-wide lock for the duration. 03:45 was chosen because no other
--   registered cron shares the minute (asserted by
--   tests/serviceable-recompute-cron.test.js) and it is the quietest window.
--   To disable, set the value to 'false' and restart — do not delete the row,
--   or the switch disappears again.
--
-- ⚠ TAKES EFFECT AT SERVER START
--   The scheduler reads this once, while registering jobs. Applying this file
--   to a running environment changes nothing until that process restarts.
--   Verify afterwards with Settings -> Scheduled Tasks, or the startup log line
--   naming the job.
--
-- IDEMPOTENCY
--   Both statements are safe to re-run. The INSERT is guarded by NOT EXISTS;
--   the UPDATE is what makes re-running this file mean "enable it", so if an
--   operator has since set it to 'false' on purpose, do NOT re-run this file —
--   it would switch the job back on.
--
-- APPLIED
--   QA (10.30.2.30 / easyfix): 2026-09-09.
--   Production: pending.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. Create the row if it is missing ──────────────────────────────

INSERT INTO easyfix_properties (property_key, property_value) SELECT 'pincode.serviceable_recompute.enabled', 'true' WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'pincode.serviceable_recompute.enabled');


-- ─── 2. Enable it ────────────────────────────────────────────────────
-- Separate from the INSERT so this file also enables an environment where the
-- row already exists reading 'false'.

UPDATE easyfix_properties SET property_value = 'true' WHERE property_key = 'pincode.serviceable_recompute.enabled';


-- ─── 3. Verify (read-only) ───────────────────────────────────────────
-- Expected: exactly one row, property_value = 'true'.

SELECT property_key, property_value, updated_at FROM easyfix_properties WHERE property_key = 'pincode.serviceable_recompute.enabled';
