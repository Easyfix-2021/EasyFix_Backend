-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-07 — Reached-location geofence: audit columns + two ops knobs
--
-- WHAT: when a technician confirms "reached location" the app now sends the
-- device's GPS fix. The server compares it against the SITE coordinates
-- (tbl_address.gps_location, the "lat,lng" GPS varchar — NOT the booked
-- address text, which is a different column role) and records the result.
--
-- WHERE OPS SEES IT: tbl_job_location_track — the EasyFix-owned live-track
-- table the CRM already reads for "where is my technician" (job_id is
-- indexed via idx_job_captured). The arrival row is the one where
-- within_fence IS NOT NULL; every routine ping leaves those three columns
-- NULL, so the discriminator is free and needs no extra column.
--
--   SELECT job_id, efr_id, latitude, longitude, distance_meters,
--          within_fence, override_reason, captured_at
--     FROM tbl_job_location_track
--    WHERE within_fence = 0 AND override_reason IS NOT NULL
--    ORDER BY captured_at DESC;
--
-- …is the abuse report: every job started from outside the fence, with the
-- reason the technician typed and how far out they were.
--
-- No existing table is altered other than this EasyFix-owned one, and every
-- column is NULLable with no default, so the ~0 existing rows stay valid and
-- every current reader (job-location.service.js selects explicit columns —
-- there is no SELECT * anywhere on this table) is unaffected.
--
-- ── THE TWO PROPERTIES, AND WHY THE ENFORCEMENT DEFAULT IS 'false' ──────
--
-- geofence.enforcement.enabled — 'true' turns the soft warning into a hard
-- 400 when the technician is outside the fence AND gave no override reason.
--
-- SEEDED 'false' ON PURPOSE, and this deliberately does NOT follow the
-- estate's usual fail-CLOSED convention for property gates. Fail-closed is
-- right when the property guards ACCESS to something — the closed position
-- denies a feature. Here the closed position denies WORK: every technician
-- in the field would be unable to start a job the moment this file merged,
-- or on any host where the properties table is briefly unreadable (the
-- properties cache primes EMPTY on a load failure, so "missing" is a state
-- production reaches without anyone changing a row). The product rule is
-- "nobody is stranded; abuse is visible to ops", so the safe default is the
-- soft path: record everything, block nothing.
--
-- geofence.radius.meters — the fence radius. Seeded 150.
--
-- NOT MEASURED. No arrival-distance data exists to fit against: this is the
-- first code in the estate that computes the distance at all, and
-- tbl_job_location_track holds essentially no rows because the new Expo app
-- is still beta-only. 150 m is a deliberate choice, not a finding:
--   - the site coordinate is frequently a reverse-geocoded or map-search pin
--     rather than a surveyed rooftop, and carries its own tens-of-metres error;
--   - a phone's horizontal accuracy in a dense Indian urban setting is
--     commonly 10-50 m and degrades exactly where these jobs are (malls,
--     gated societies, basements) — the same sites that need a gate pass;
--   - a large mall or society is itself 100-200 m across, so a technician
--     standing at the correct gate can legitimately be >100 m from the pin.
-- 150 m is loose enough not to flag an honest arrival and tight enough that
-- "started the job from the previous neighbourhood" falls outside. Tune it
-- from the audit query above once real rows exist — that is what the
-- property is for.
--
-- Both keys are read through services/properties.service.js (1h TTL cache +
-- the admin reload gesture), so changing either is a row edit, no deploy.
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE tbl_job_location_track ADD COLUMN distance_meters DECIMAL(10,2) DEFAULT NULL;

ALTER TABLE tbl_job_location_track ADD COLUMN within_fence TINYINT(1) DEFAULT NULL;

ALTER TABLE tbl_job_location_track ADD COLUMN override_reason VARCHAR(500) DEFAULT NULL;

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'geofence.enforcement.enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'geofence.enforcement.enabled');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'geofence.radius.meters', '150'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'geofence.radius.meters');
