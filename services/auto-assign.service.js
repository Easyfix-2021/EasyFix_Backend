const { pool } = require('../db');
const logger = require('../logger');
const { haversineKm } = require('../utils/haversine');
const jobService = require('./job.service');

/*
 * 3-layer auto-assignment pipeline (blueprint §5).
 *
 * Layer 1 — SQL eligibility filter:
 *   - efr_service_category matches job's service category (LIKE '%…%')
 *   - efr_cityId == job's city
 *   - efr_status = 1
 *   - is_technician_verified = 1
 *   - efr_id is NOT in scheduling_history for this job with a non-null
 *     reschedule_reason (i.e. previously rescheduled off this job — don't offer again)
 *
 * Layer 2 — code availability filter:
 *   - active jobs (status 0/1/2) < MAX_CONCURRENT_JOBS
 *   - distance from customer GPS to efr_base_gps < MAX_TRAVEL_DISTANCE_KM
 *     (IMPORTANT: use efr_base_gps, not efr_current_gps — see blueprint)
 *   - no overlapping time-slot booking on same date
 *
 * Layer 3 — weighted scoring (higher = better), stats from last 90 days:
 *   distance_score   = (MAX_DIST - distance) / MAX_DIST
 *   workload_score   = (MAX_JOBS - active_jobs) / MAX_JOBS
 *   rating_score     = avg_customer_rating / 5                  (default 3.0 if no ratings)
 *   completion_score = completed / (completed + cancelled)      (default 0.8 if no history)
 *   score = W_DIST·d + W_WORK·w + W_RATE·r + W_COMP·c
 */

const CONFIG = {
  get MAX_TRAVEL_DISTANCE_KM()    { return Number(process.env.MAX_TRAVEL_DISTANCE_KM || 15); },
  get MAX_CONCURRENT_JOBS()       { return Number(process.env.MAX_CONCURRENT_JOBS || 5); },
  get W_DISTANCE()                { return Number(process.env.WEIGHT_DISTANCE || 0.35); },
  get W_WORKLOAD()                { return Number(process.env.WEIGHT_WORKLOAD || 0.30); },
  get W_RATING()                  { return Number(process.env.WEIGHT_RATING || 0.20); },
  get W_COMPLETION()              { return Number(process.env.WEIGHT_COMPLETION || 0.15); },
  STATS_LOOKBACK_DAYS: 90,
  DEFAULT_RATING: 3.0,
  DEFAULT_COMPLETION: 0.8,
};

// ─── Layer 1: SQL eligibility ───────────────────────────────────────
async function eligibleCandidates(job) {
  const serviceCategory = job.service_categories_dashboard || ''; // legacy field; fallback to empty match
  // Prefer resolving from attached service types; if not available, use stored category.
  const [rows] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_base_gps, e.efr_current_gps,
            e.efr_service_category, e.efr_cityId,
            e.is_technician_verified
       FROM tbl_easyfixer e
      WHERE e.efr_status = 1
        AND e.is_technician_verified = 1
        AND e.efr_cityId = ?
        AND (? = '' OR e.efr_service_category LIKE CONCAT('%', ?, '%'))
        AND e.efr_id NOT IN (
          SELECT sh.easyfixer_id FROM scheduling_history sh
           WHERE sh.job_id = ? AND sh.reschedule_reason IS NOT NULL AND sh.reschedule_reason <> ''
        )`,
    [job.city_id, serviceCategory, serviceCategory, job.job_id]
  );
  return rows;
}

// ─── Layer 2 + 3: batch stats for candidates ────────────────────────
async function statsForCandidates(efrIds, jobRequestedTs, jobTimeSlot) {
  if (efrIds.length === 0) return new Map();
  const placeholders = efrIds.map(() => '?').join(',');

  // active jobs (open/scheduled/in-progress)
  const [activeRows] = await pool.query(
    `SELECT fk_easyfixter_id AS efr_id, COUNT(*) AS active_jobs
       FROM tbl_job WHERE fk_easyfixter_id IN (${placeholders})
                      AND job_status IN (0, 1, 2)
      GROUP BY fk_easyfixter_id`,
    efrIds
  );
  const activeMap = new Map(activeRows.map((r) => [r.efr_id, Number(r.active_jobs)]));

  // time-slot conflicts: any job on same date+slot
  const reqDate = jobRequestedTs ? new Date(jobRequestedTs).toISOString().slice(0, 10) : null;
  const conflictMap = new Map();
  if (reqDate && jobTimeSlot) {
    const [conflicts] = await pool.query(
      `SELECT DISTINCT fk_easyfixter_id AS efr_id
         FROM tbl_job
        WHERE fk_easyfixter_id IN (${placeholders})
          AND DATE(requested_date_time) = ?
          AND time_slot = ?
          AND job_status IN (0, 1, 2)`,
      [...efrIds, reqDate, jobTimeSlot]
    );
    for (const r of conflicts) conflictMap.set(r.efr_id, true);
  }

  // rating (90d avg)
  const [ratingRows] = await pool.query(
    `SELECT easyfixer_id AS efr_id, AVG(customer_rating) AS avg_rating, COUNT(*) AS rating_count
       FROM tbl_easyfixer_rating_by_customer
      WHERE easyfixer_id IN (${placeholders})
        AND insert_date_time >= DATE_SUB(NOW(), INTERVAL ${CONFIG.STATS_LOOKBACK_DAYS} DAY)
      GROUP BY easyfixer_id`,
    efrIds
  );
  const ratingMap = new Map(ratingRows.map((r) => [r.efr_id, Number(r.avg_rating)]));

  // completion ratio (90d)
  const [histRows] = await pool.query(
    `SELECT fk_easyfixter_id AS efr_id,
            SUM(CASE WHEN job_status IN (3, 5) THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN job_status = 6 THEN 1 ELSE 0 END) AS cancelled
       FROM tbl_job
      WHERE fk_easyfixter_id IN (${placeholders})
        AND created_date_time >= DATE_SUB(NOW(), INTERVAL ${CONFIG.STATS_LOOKBACK_DAYS} DAY)
      GROUP BY fk_easyfixter_id`,
    efrIds
  );
  const completionMap = new Map();
  for (const r of histRows) {
    const c = Number(r.completed);
    const x = Number(r.cancelled);
    if (c + x > 0) completionMap.set(r.efr_id, c / (c + x));
  }

  // merge
  const out = new Map();
  for (const id of efrIds) {
    out.set(id, {
      active_jobs: activeMap.get(id) ?? 0,
      has_conflict: conflictMap.get(id) === true,
      avg_rating:   ratingMap.get(id) ?? CONFIG.DEFAULT_RATING,
      completion:   completionMap.get(id) ?? CONFIG.DEFAULT_COMPLETION,
    });
  }
  return out;
}

function score({ distance, activeJobs, rating, completion }) {
  const MAX_D = CONFIG.MAX_TRAVEL_DISTANCE_KM;
  const MAX_J = CONFIG.MAX_CONCURRENT_JOBS;
  const dS = Math.max(0, (MAX_D - distance) / MAX_D);
  const wS = Math.max(0, (MAX_J - activeJobs) / MAX_J);
  const rS = Math.max(0, Math.min(1, rating / 5));
  const cS = Math.max(0, Math.min(1, completion));
  const total =
    CONFIG.W_DISTANCE  * dS +
    CONFIG.W_WORKLOAD  * wS +
    CONFIG.W_RATING    * rS +
    CONFIG.W_COMPLETION * cS;
  return { total, breakdown: { distance: dS, workload: wS, rating: rS, completion: cS } };
}

// ─── Main candidates entrypoint ─────────────────────────────────────
async function getCandidates(jobId, { limit = 10, ignoreDistance = false } = {}) {
  const job = await jobService.getById(jobId);
  if (!job) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  if (job.fk_easyfixter_id) {
    return {
      job,
      alreadyAssigned: true,
      assignedTo: job.fk_easyfixter_id,
      candidates: [],
    };
  }

  const customerGps = job.gps_location;
  const eligible = await eligibleCandidates(job);
  if (eligible.length === 0) {
    return { job, alreadyAssigned: false, candidates: [], notes: ['no L1-eligible technicians for this city/category'] };
  }

  const stats = await statsForCandidates(
    eligible.map((e) => e.efr_id),
    job.requested_date_time,
    job.time_slot
  );

  const scored = [];
  const rejected = [];
  for (const e of eligible) {
    const s = stats.get(e.efr_id);
    const distance = customerGps ? haversineKm(customerGps, e.efr_base_gps) : (ignoreDistance ? 0 : Infinity);

    // L2 filters
    if (s.active_jobs >= CONFIG.MAX_CONCURRENT_JOBS) {
      rejected.push({ efr_id: e.efr_id, reason: `saturated (${s.active_jobs} active jobs)` }); continue;
    }
    if (!ignoreDistance && distance > CONFIG.MAX_TRAVEL_DISTANCE_KM) {
      rejected.push({ efr_id: e.efr_id, reason: `too far (${distance.toFixed(1)} km > ${CONFIG.MAX_TRAVEL_DISTANCE_KM})` }); continue;
    }
    if (s.has_conflict) {
      rejected.push({ efr_id: e.efr_id, reason: 'time-slot conflict on requested date' }); continue;
    }

    // L3 scoring
    const scoreObj = score({
      distance, activeJobs: s.active_jobs, rating: s.avg_rating, completion: s.completion,
    });
    scored.push({
      efr_id: e.efr_id,
      efr_name: e.efr_name,
      efr_no: e.efr_no,
      efr_base_gps: e.efr_base_gps,
      distance_km: distance,
      active_jobs: s.active_jobs,
      avg_rating: Number(s.avg_rating.toFixed(2)),
      completion_ratio: Number(s.completion.toFixed(2)),
      score: Number(scoreObj.total.toFixed(4)),
      breakdown: Object.fromEntries(Object.entries(scoreObj.breakdown).map(([k, v]) => [k, Number(v.toFixed(3))])),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    job: {
      job_id: job.job_id,
      requested_date_time: job.requested_date_time,
      time_slot: job.time_slot,
      city_id: job.city_id,
      city_name: job.city_name,
      gps_location: job.gps_location,
      service_category: job.service_categories_dashboard,
    },
    alreadyAssigned: false,
    config: {
      MAX_TRAVEL_DISTANCE_KM: CONFIG.MAX_TRAVEL_DISTANCE_KM,
      MAX_CONCURRENT_JOBS: CONFIG.MAX_CONCURRENT_JOBS,
      weights: {
        distance: CONFIG.W_DISTANCE, workload: CONFIG.W_WORKLOAD,
        rating: CONFIG.W_RATING, completion: CONFIG.W_COMPLETION,
      },
    },
    l1Count: eligible.length,
    rejectedCount: rejected.length,
    candidates: scored.slice(0, limit),
    rejectedSample: rejected.slice(0, 10),
  };
}

// ─── Single-job auto-assign ─────────────────────────────────────────
async function assignTopCandidate(jobId, actor) {
  const result = await getCandidates(jobId, { limit: 1 });
  if (result.alreadyAssigned) {
    const err = new Error(`job ${jobId} is already assigned to easyfixer ${result.assignedTo}`);
    err.status = 409;
    throw err;
  }
  if (!result.candidates.length) {
    const err = new Error('no eligible candidate found');
    err.status = 422;
    err.details = { l1Count: result.l1Count, rejectedCount: result.rejectedCount };
    throw err;
  }
  const top = result.candidates[0];
  const assigned = await jobService.assign(jobId, { easyfixerId: top.efr_id }, actor);
  return { job: assigned, chosen: top, l1Count: result.l1Count, rejectedCount: result.rejectedCount };
}

// ─── Bulk auto-assign for all unassigned booked jobs ────────────────
async function bulkAssignUnassigned({ limit = 50, dryRun = false } = {}, actor) {
  const [unassigned] = await pool.query(
    `SELECT job_id FROM tbl_job
      WHERE fk_easyfixter_id IS NULL
        AND job_status = ${jobService.STATUS.BOOKED}
      ORDER BY job_id ASC LIMIT ?`,
    [Number(limit)]
  );

  const results = [];
  let assignedCount = 0;
  for (const { job_id } of unassigned) {
    try {
      const candidates = await getCandidates(job_id, { limit: 1 });
      if (!candidates.candidates.length) {
        results.push({ jobId: job_id, status: 'no_candidate', l1Count: candidates.l1Count, rejectedCount: candidates.rejectedCount });
        continue;
      }
      const top = candidates.candidates[0];
      if (dryRun) {
        results.push({ jobId: job_id, status: 'would_assign', efrId: top.efr_id, score: top.score });
      } else {
        await jobService.assign(job_id, { easyfixerId: top.efr_id }, actor);
        assignedCount++;
        results.push({ jobId: job_id, status: 'assigned', efrId: top.efr_id, score: top.score });
      }
    } catch (e) {
      logger.warn({ jobId: job_id, err: e.message }, 'bulk auto-assign row failed');
      results.push({ jobId: job_id, status: 'failed', error: e.message });
    }
  }
  return { summary: { examined: unassigned.length, assignedCount, dryRun }, results };
}

module.exports = { getCandidates, assignTopCandidate, bulkAssignUnassigned, CONFIG };
