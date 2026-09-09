-- =====================================================================
-- Schedule & Assign (candidate ranking) — EXPLAIN pack + index findings
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--
-- After the 2026-09-08 pool-exhaustion incident, "Schedule & Assign is slow
-- because of two missing indexes" was carried forward as received wisdom. It
-- was measured on 2026-09-08 and it is NOT what the evidence says. This file
-- records what was actually measured, so the claim does not get re-derived from
-- memory a third time.
--
-- ---------------------------------------------------------------------
-- WHAT WAS MEASURED (QA: 10.30.2.30, easyfix — 481,048 tbl_job rows,
-- 10,356 technicians / 4,680 active)
-- ---------------------------------------------------------------------
--
-- Method: wrap pool.query to capture every statement one real
-- rankCandidatesForJob() call issues, time each, then EXPLAIN it. Sampling the
-- live mysql2 pool in parallel gave the concurrency figure.
--
--   43 statements per Schedule & Assign open
--   PEAK 16 SIMULTANEOUS POOL ACQUIRES, held for the whole call
--   NO statement used type=ALL. Every query already walks an index.
--
-- THE FINDING WAS NOT AN INDEX. It was fan-out WIDTH. Against production's
-- connectionLimit 30 / queueLimit 50 (db.js), 16 acquires per open means:
--       2 concurrent opens → the pool is full, requests begin queueing
--       6 concurrent opens → 96 acquires vs an 80 ceiling → mysql2 throws
--                            "Queue limit reached." to EVERY request in the
--                            process, including the per-request auth lookup
-- Fixed in services/candidate-ranking.service.js by a module-level bulkhead
-- (RANKING_STATS_CONCURRENCY, default 12). Verified: 6 concurrent opens peaked
-- at 50 in-use connections uncapped vs 20 capped, with byte-identical candidate
-- output at every cap setting. See tests/ranking-pool-bulkhead.test.js.
--
-- ---------------------------------------------------------------------
-- THE ONE REMAINING INDEX CANDIDATE — AND WHY IT IS UNPROVEN
-- ---------------------------------------------------------------------
--
-- The heaviest statements are the per-technician stats aggregates. Shape:
--
--   SELECT fk_easyfixter_id, AVG(TIMESTAMPDIFF(HOUR, scheduled_date_time,
--                                              checkout_date_time))
--     FROM tbl_job
--    WHERE fk_easyfixter_id IN (<~60 ids>)
--      AND job_status IN (3, 5)
--      AND created_date_time >= DATE_SUB(NOW(), INTERVAL 90 DAY)   -- RESIDUAL
--    GROUP BY fk_easyfixter_id;
--
-- tbl_job carries idx_job_fk_easyfixter_status (fk_easyfixter_id, job_status).
-- The 90-day created_date_time bound is NOT in it, so MySQL walks every
-- (efr, status) entry and filters the date afterwards — EXPLAIN showed
-- rows=11,312 examined per statement. A composite carrying the date would turn
-- that residual into a range.
--
-- ⚠ DO NOT ADD IT ON THE STRENGTH OF THAT PARAGRAPH ALONE. Two things must be
--   settled first, and neither can be settled from QA:
--
--   (1) [ANSWERED 2026-09-08 — see section 2b.] The benefit could not be
--       measured on QA: its newest tbl_job row is 2026-08-24 and only 45 of
--       481,048 rows fall inside the 90-day window, so any before/after there
--       measures the restore's age. Measured on PRODUCTION instead: 10.3% of
--       the rows the existing index reads survive the date filter.
--
--   (2) A PRIOR DECISION ALREADY DECLINED THIS, ON PURPOSE. See
--       migrations/executed/2026-05-06-candidate-ranking-indexes-and-defaults.sql
--       and the header of services/candidate-ranking.service.js: a tbl_job
--       composite was skipped because "tbl_job already carries a thick set of
--       single-column indexes from legacy and adding another wide one
--       materially slows down INSERTs". tbl_job is the hottest write table in
--       the system. That trade-off has to be answered with numbers, not
--       overruled silently.
--
-- ---------------------------------------------------------------------
-- 1. WHAT INDEXES EXIST TODAY (run first — the answer may already be here)
-- ---------------------------------------------------------------------
-- ⚠ tbl_job_image and scheduling_history are in this list DELIBERATELY. The
-- first version of this query omitted them, which was the one real gap: they
-- hold idx_job_image_job and idx_sched_hist_job, the two indexes filed in
-- migrations/executed/ on 2026-07-01 whose PRESENCE ON PROD is still unverified.
-- A run that omits them answers a question nobody asked.
SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, CARDINALITY
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('tbl_job', 'tbl_job_image', 'scheduling_history',
                      'tbl_easyfixer', 'tbl_easyfixer_attendance',
                      'tbl_easyfixer_rating_by_customer', 'tbl_vertical_mapping')
 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- The direct question, if you only want the answer:
SELECT TABLE_NAME, INDEX_NAME, 'PRESENT' AS state
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND INDEX_NAME IN ('idx_job_image_job', 'idx_sched_hist_job')
 GROUP BY TABLE_NAME, INDEX_NAME;
-- Zero rows = MISSING on this environment. Both are present on QA
-- (re-confirmed 2026-09-08) and both migration files sit in migrations/executed/.

-- As of 2026-09-08 the relevant tbl_job indexes are:
--   idx_job_fk_easyfixter_status  (fk_easyfixter_id, job_status)
--   idx_job_efr_status_checkin    (fk_easyfixter_id, job_status, checkin_date_time)
--   idx_job_efr_under_audit       (fk_easyfixter_id, job_status, no_of_req_approval, …)


-- ---------------------------------------------------------------------
-- 2. SELECTIVITY — RUN THIS ONE. It does not sample.
--
-- ⚠ THREE SAMPLED VERSIONS OF THIS MEASUREMENT WERE WRONG BEFORE THIS ONE, in
-- three different ways, and every one of them returned a confident number:
--
--   `ORDER BY efr_id DESC LIMIT 60`  → the NEWEST technicians. Auto-increment
--       ids are monotonic in time, so new joiners only have recent jobs and the
--       90-day filter keeps ~everything. Production returned 104/104 = "the
--       filter is useless". Sample bias, not a fact about the data.
--   `ORDER BY efr_id ASC LIMIT 60`   → the OLDEST technicians. Long-tenured but
--       frequently dormant: Bengaluru's 60 oldest produced 78 jobs in 90 days,
--       1.3 each. Opposite bias, same failure.
--   `SELECT @city := c.city_id … LIMIT 5` → MySQL assigns the variable ONCE PER
--       ROW, so @city ends up holding the FIFTH city, not the first. Two runs
--       intended for the busiest city silently measured two different cities
--       (Pune, then Bengaluru) and were compared to each other. Verified:
--       @city = 8 after that statement, with Bengaluru (9) as row 1.
--
-- The question never needed a technician sample. Selectivity is a property of
-- the TABLE under the query's own predicate shape, so measure it there: no
-- LIMIT, no ORDER BY, no session variable, nothing to bias. ~1.3s over ~491k
-- rows — cheap enough to run on a replica whenever the answer is needed again.
--
-- Read it as: of the rows the EXISTING index hands the engine, what fraction
-- survives the 90-day residual? A small fraction means the date column belongs
-- in the index; a large fraction means the composite buys nothing and its write
-- cost is pure loss.

SELECT
  -- TAT query (candidate-ranking.service.js:868) — filters job_status IN (3,5).
  -- Denominator = what idx_job_fk_easyfixter_status currently reads.
  SUM(job_status IN (3,5))                                         AS tat_all_time,
  SUM(job_status IN (3,5)
      AND created_date_time >= DATE_SUB(NOW(), INTERVAL 90 DAY))   AS tat_in_window,
  -- SDA query (:882) — NO job_status in its WHERE (only inside CASE), so its
  -- denominator is every job with a technician. This is the consumer a
  -- status-in-the-middle composite cannot help.
  COUNT(*)                                                         AS sda_all_time,
  SUM(created_date_time >= DATE_SUB(NOW(), INTERVAL 90 DAY))       AS sda_in_window
  FROM tbl_job
 WHERE fk_easyfixter_id IS NOT NULL;

-- HOW TO READ THE RESULT
--   tat_in_window / tat_all_time  → selectivity for the 3-column composite
--   sda_in_window / sda_all_time  → selectivity for a 2-column (efr, created)
--   tat_in_window vs sda_in_window → if these are CLOSE, (efr, created_date_time)
--       serves both consumers and the 3-column shape is the wrong trade: it
--       optimises one query and leaves the other on the single-column FK index.
--   Either ratio above ~50%: do not add the index at all.

-- ---------------------------------------------------------------------
-- 2b. SAMPLED ON PRODUCTION, 2026-09-08 — suggestive; §2 is what settles it
-- ---------------------------------------------------------------------
--
--   rows_from_index   4383      jobs_per_tech 88.7
--   rows_after_date    453      → SELECTIVITY 10.3%
--
-- ⚠ SUGGESTIVE, NOT SETTLED — this is ONE CITY's 60 oldest active technicians,
-- and it turned out to be PUNE rather than the intended Bengaluru (the
-- `SELECT @city := … LIMIT 5` assignment bug, see §2). It is the best of the
-- three sampled attempts — 88.7 jobs/tech means these are genuinely active
-- technicians, not new joiners — but a second city measured the same way gave
-- 1.3 jobs/tech, so single-city samples plainly do not generalise here.
--
-- Take 10.3% as "the date column looks worth indexing, go and confirm", and
-- confirm with the UNSAMPLED query in §2, which has no sample to be wrong about.
-- Nothing should be altered on tbl_job on the strength of this figure alone.
--
-- ALSO CONFIRMED on production the same day: idx_job_image_job and
-- idx_sched_hist_job are BOTH PRESENT. The 2026-07-01 pair is fully landed;
-- nothing outstanding there.
--
-- ⚠ BUT ONE INDEX CANNOT SERVE BOTH CONSUMERS. Two ranking queries carry the
-- 90-day bound and they have DIFFERENT predicate shapes:
--
--   candidate-ranking.service.js:868 (TAT)
--       WHERE fk_easyfixter_id IN (...) AND job_status IN (3,5)
--         AND created_date_time >= ...
--     → wants (fk_easyfixter_id, job_status, created_date_time).
--       This is the query the 10.3% above was measured against.
--
--   candidate-ranking.service.js:882 (SDA / attempted)
--       WHERE fk_easyfixter_id IN (...) AND created_date_time >= ...
--       (job_status appears only inside CASE expressions, NOT in the WHERE)
--     → a composite with job_status SECOND is useless to it: with the middle
--       column unconstrained MySQL cannot range-scan the third. It currently
--       rides FKppx0ackbclgoo62vh3bshcw6r and examined 12,800 rows.
--       This one wants (fk_easyfixter_id, created_date_time).
--
-- (fk_easyfixter_id, created_date_time) serves BOTH: query 882 fully, and 868
-- as an efr+date range with job_status demoted to a residual — still far less
-- than today. Settle it with the query below before choosing.

-- Which index wins: how many rows land in the window WITHOUT the status filter?
-- If this is close to rows_after_date above, the 2-column (efr, created) index
-- serves both consumers and the 3-column one is the wrong shape.
SET @efrs = (SELECT GROUP_CONCAT(efr_id) FROM (
  SELECT e.efr_id FROM tbl_easyfixer e
   WHERE e.efr_status = 1 AND e.efr_cityId = @city
   ORDER BY e.efr_id LIMIT 60) t);
SELECT
  (SELECT COUNT(*) FROM tbl_job WHERE FIND_IN_SET(fk_easyfixter_id, @efrs)
     AND created_date_time >= DATE_SUB(NOW(), INTERVAL 90 DAY))  AS in_window_any_status,
  (SELECT COUNT(*) FROM tbl_job WHERE FIND_IN_SET(fk_easyfixter_id, @efrs)
     AND job_status IN (3,5)
     AND created_date_time >= DATE_SUB(NOW(), INTERVAL 90 DAY))  AS in_window_completed;

-- ---------------------------------------------------------------------
-- 2c. THE SHAPE IS SARGABLE — proven, on an index that already exists
-- ---------------------------------------------------------------------
--
-- Before proposing an index carrying created_date_time, confirm MySQL will
-- actually range-scan that third key part rather than treating it as a residual.
-- No need to create anything: idx_job_efr_status_checkin is already
-- (fk_easyfixter_id, job_status, checkin_date_time) — the same shape. EXPLAIN it.
--
--   A) …AND checkin_date_time >= DATE_SUB(NOW(), INTERVAL 90 DAY)
--        type=range  key_len=16  rows=2       ← 3 key parts used
--   B) …no date predicate at all
--        type=range  key_len=10  rows=1253    ← 2 key parts
--   C) …AND DATE(checkin_date_time) >= CURDATE()     [function ON the column]
--        type=range  key_len=10  rows=1253    ← 2 key parts: the date is IGNORED
--
-- A vs B is the proof: key_len grows 10 -> 16, so the third column is genuinely
-- used, and the read collapses. C is the negative control and it earns its place
-- — if A and C had both shown key_len 16 the probe could not discriminate, and
-- the "proof" would have been an artefact.
--
-- The operative rule, which the ranking service already documents for a
-- different predicate: keep the function on the VALUE side. `col >= NOW() - n`
-- is a range; `DATE(col) >= …` is a full scan of the remaining key parts.
-- (candidate-ranking.service.js's header notes `TIME(requested_date_time) <>
-- '00:00:00'` is non-sargable for exactly this reason — that one is a residual
-- by design, and no index will change it.)

-- ---------------------------------------------------------------------
-- 2d. THE WRITE-COST OBJECTION HAS AN ANSWER: REPLACE, DON'T ADD
-- ---------------------------------------------------------------------
--
-- tbl_job carries 29 distinct indexes (counted from a production
-- information_schema dump, 2026-09-08) — which is exactly why the 2026-05-06
-- migration declined to add another. That objection is real and it is also
-- ANSWERABLE, because three of those 29 share the same leftmost prefix:
--
--   FKppx0ackbclgoo62vh3bshcw6r   (fk_easyfixter_id)
--   idx_job_fk_easyfixter_status  (fk_easyfixter_id, job_status)
--   idx_job_efr_status_checkin    (fk_easyfixter_id, job_status, checkin_date_time)
--   idx_job_efr_under_audit       (fk_easyfixter_id, job_status, no_of_req_approval, …)
--
-- A B-tree on (a,b,c) already serves every query an index on (a) or (a,b) can
-- serve. So idx_job_fk_easyfixter_status is ALREADY redundant with
-- idx_job_efr_status_checkin, today, before any change. Replacing it costs no
-- net index — the count stays at 29 and the per-row write cost barely moves,
-- because the new index is one column wider rather than one B-tree more.
--
-- Verify the redundancy independently before acting (pt-duplicate-key-checker,
-- or the STATISTICS dump above): the argument rests on it entirely.

-- ---------------------------------------------------------------------
-- 3. THE CANDIDATE, IF AND ONLY IF STEP 2 JUSTIFIES IT
--
--    Do not run this as part of an audit. It is a write against the hottest
--    table in the system and belongs in a reviewed migration with a DBA, in a
--    quiet window, with ALGORITHM/LOCK stated (both INPLACE/NONE are supported
--    for ADD INDEX on MySQL 8) — see
--    migrations/executed/2026-08-10-index-job-offer-mobile-latest.sql for the
--    house pattern.
--
--    Measure INSERT cost as well as SELECT benefit before keeping it.
-- ---------------------------------------------------------------------
-- ALTER TABLE tbl_job
--   ADD INDEX idx_job_efr_status_created (fk_easyfixter_id, job_status, created_date_time),
--   ALGORITHM=INPLACE, LOCK=NONE;


-- ---------------------------------------------------------------------
-- 4. RE-RUN THE PROFILE AFTER ANY CHANGE
--    The application-level harness is the honest measurement, because it counts
--    ROUND TRIPS and POOL CONCURRENCY, not just single-statement time — and
--    concurrency, not statement cost, is what took the process down.
--    See tests/ranking-pool-bulkhead.test.js for the invariant it must keep.
-- ---------------------------------------------------------------------
