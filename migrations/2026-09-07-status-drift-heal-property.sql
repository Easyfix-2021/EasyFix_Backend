-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-07 — Technician status-drift repair: cron kill-switch
--
-- WHY: tbl_easyfixer stores a technician's status TWICE. The legacy Java CRM
-- reads and writes `efr_status`; this backend renders and writes
-- `lifecycle_status`. Every write here sets both in one UPDATE
-- (easyfixer-lifecycle.service.js legacyStatusForTransition), so they normally
-- agree. The legacy CRM does not know the second column exists, so activating
-- or deactivating a technician there changes only one of the two.
--
-- WHY THAT IS INVISIBLE: work eligibility ANDs both halves
-- (easyfixer-work-eligibility.sqlPredicate), so a technician reactivated in the
-- legacy CRM reads Active on every screen ops uses and silently receives no job
-- offers at all. Nothing errors and nothing is logged. Reported 2026-09-07 for
-- efr 4980 — Active in the legacy CRM, Inactive in the new one, and the new
-- CRM's own Status=Active filter RETURNED the row whose chip said Inactive.
--
-- SEEDED 'false', deliberately. This cron WRITES (it moves lifecycle_status
-- through the audited transition), so merging this file cannot start changing
-- technician statuses in production. With it off the schedule is dormant while
-- the counts-strip monitor still reports the number, and Trigger Now / Test on
-- Settings -> Scheduled Tasks still work — which is how a single reported
-- technician gets fixed without enabling anything.
--
-- Its own key rather than reusing easyfixer.auto_reactivation.enabled: that
-- property reads 'false' today, and a data-integrity repair must not be
-- switchable by whoever later turns an unrelated convenience feature off.
--
-- Takes effect at server start (the scheduler reads it once), so flipping it
-- to 'true' needs a restart.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'easyfixer.status_drift_heal.enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'easyfixer.status_drift_heal.enabled');
