const { pool } = require('../db');

/*
 * Job CRUD + status + assignment.
 *
 * Schema notes (tbl_job, 141 cols, ~384k rows as of 2026-04-17):
 *   - fk_easyfixter_id  ← legacy typo. Do NOT "fix" to easyfixer — 5 services depend on the spelling.
 *   - Efr_dis_travelled ← capital E, preserved.
 *   - source_type (varchar) is the human-readable source ("manual", "excel",
 *     "dashboard", "decathlon API"); `source` (tinyint) is legacy.
 *
 * Writes: create + assign + certain status transitions are multi-row and
 * wrapped in a transaction. Simple column updates (update, most status
 * changes) use the pool directly.
 */

// ─── Status glossary (blueprint §3) ─────────────────────────────────
/*
 * Canonical job_status codes (truth from legacy DB, documented 2026-04-20):
 *
 *   0  BOOKED          — default on create. Sub-states:
 *                         • fk_easyfixter_id IS NULL  → "Pending for Scheduling"
 *                         • fk_easyfixter_id NOT NULL → "Pending App Acknowledge"
 *   1  SCHEDULED       — accepted by tech on app, pending check-in
 *   2  IN_PROGRESS     — technician checked in on app
 *   3  COMPLETED       — closed (QA path)
 *   5  COMPLETED_ALT   — closed (legacy alternative completion)
 *   6  CANCELLED       — cancelled by ops
 *   7  ENQUIRY         — information request only (legacy; keep)
 *   9  UNCONFIRMED     — job booked from website / API / dashboard / bulk
 *                        upload, customer not yet confirmed
 *  10  CLOSED_FROM_APP — closed from tech app / estimate approved or rejected
 *  15  ESTIMATE_PENDING_APPROVAL — estimate sent, awaiting customer decision
 *  20  IN_PROGRESS_ALT — second IN_PROGRESS state used by some app paths
 *  21  ON_HOLD         — fulfilment on hold
 *
 * Kept existing NAMES (BOOKED / SCHEDULED / CALL_LATER / REVISIT) as aliases
 * so the 20+ files referencing STATUS.CALL_LATER / STATUS.REVISIT keep
 * compiling without a churn-wide rename. The new CANONICAL names live as
 * separate properties — prefer them in new code.
 */
const STATUS = {
  BOOKED: 0, SCHEDULED: 1, IN_PROGRESS: 2,
  COMPLETED: 3, COMPLETED_ALT: 5, CANCELLED: 6,
  ENQUIRY: 7, CALL_LATER: 9, REVISIT: 10,
  // Canonical additions (DB-truth per 2026-04-20):
  UNCONFIRMED: 9,                 // alias for CALL_LATER
  CLOSED_FROM_APP: 10,            // alias for REVISIT
  ESTIMATE_PENDING_APPROVAL: 15,
  IN_PROGRESS_ALT: 20,
  ON_HOLD: 21,
};
const ALL_STATUS_VALUES = new Set(Object.values(STATUS));
// Composite buckets for multi-status queries and UI tabs.
const CHECKED_IN_STATES = new Set([STATUS.IN_PROGRESS, STATUS.IN_PROGRESS_ALT]);
const CLOSED_STATES = new Set([STATUS.COMPLETED, STATUS.COMPLETED_ALT]);

// Terminal states — `setStatus` to these sets stamp timestamps
const COMPLETED_STATES = new Set([STATUS.COMPLETED, STATUS.COMPLETED_ALT]);

// ─── Projections ────────────────────────────────────────────────────
const LIST_COLUMNS = `
  j.job_id, j.job_reference_id, j.client_ref_id,
  j.job_status, j.job_type, j.source_type,
  LEFT(j.job_desc, 200) AS job_desc,
  j.created_date_time, j.requested_date_time, j.scheduled_date_time,
  j.checkin_date_time, j.checkout_date_time,
  j.fk_customer_id, cu.customer_name, cu.customer_mob_no,
  j.fk_client_id, cl.client_name,
  j.fk_easyfixter_id, ef.efr_name AS easyfixer_name,
  j.job_owner, ow.user_name AS owner_name,
  j.fk_address_id, ci.city_name
`;

/*
 * Join map — the LIST data query pulls these for display columns. For COUNT
 * queries we include only the joins that the actual WHERE clause references,
 * which on a 384k-row table is the difference between a 6-way join full-scan
 * (~6s) and a single-table count over an indexed column (~50ms).
 */
const LIST_JOIN = `
  FROM tbl_job j
  LEFT JOIN tbl_customer    cu ON cu.customer_id = j.fk_customer_id
  LEFT JOIN tbl_address     ad ON ad.address_id  = j.fk_address_id
  LEFT JOIN tbl_city        ci ON ci.city_id     = ad.city_id
  LEFT JOIN tbl_client      cl ON cl.client_id   = j.fk_client_id
  LEFT JOIN tbl_easyfixer   ef ON ef.efr_id      = j.fk_easyfixter_id
  LEFT JOIN tbl_user        ow ON ow.user_id     = j.job_owner
`;

// Kept for getById(), which does select these as part of the full detail payload.
const DETAIL_JOIN = LIST_JOIN + `
  LEFT JOIN tbl_user        cr ON cr.user_id     = j.fk_created_by
`;

// ─── List ───────────────────────────────────────────────────────────
async function list({
  q, status, statuses, assigned, clientId, cityId, ownerId, easyfixerId,
  startDate, endDate,
  limit = 50, offset = 0,
} = {}) {
  const clauses = [];
  const params = [];

  // `statuses` (array/CSV) takes priority over single `status` — supports UI
  // tabs that bucket multiple codes (e.g. "Pending to Close" = 2 OR 20,
  // "Audit & Complete" = 3 OR 5). Single `status` still works for backward
  // compat with existing callers.
  if (statuses != null) {
    const arr = Array.isArray(statuses)
      ? statuses
      : String(statuses).split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (arr.length) {
      clauses.push(`j.job_status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
  } else if (status != null) {
    clauses.push('j.job_status = ?');
    params.push(status);
  }
  /*
   * `assigned` splits BOOKED (and any other status) by whether a technician
   * is currently on the job. Used by the dashboard's Pending-for-Scheduling
   * (assigned=false) vs Pending-App-Acknowledge (assigned=true) cards.
   * Accepts boolean true/false or string "true"/"false" from query params.
   */
  if (assigned !== undefined && assigned !== null && assigned !== '') {
    const wantAssigned = assigned === true || assigned === 'true' || assigned === 1 || assigned === '1';
    clauses.push(wantAssigned ? 'j.fk_easyfixter_id IS NOT NULL' : 'j.fk_easyfixter_id IS NULL');
  }
  if (clientId != null)    { clauses.push('j.fk_client_id = ?');     params.push(clientId); }
  if (easyfixerId != null) { clauses.push('j.fk_easyfixter_id = ?'); params.push(easyfixerId); }
  if (ownerId != null)     { clauses.push('j.job_owner = ?');        params.push(ownerId); }
  if (cityId != null)      { clauses.push('ad.city_id = ?');         params.push(cityId); }
  if (startDate)           { clauses.push('j.created_date_time >= ?'); params.push(startDate); }
  if (endDate)             { clauses.push('j.created_date_time <= ?'); params.push(endDate); }
  if (q) {
    clauses.push('(j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Build a minimal join set for COUNT based on which aliases are referenced
  // in the WHERE clause. If the filter only hits tbl_job columns (the common
  // case: status tabs, no extra filter), we can count over tbl_job alone —
  // a single-table indexed scan vs. a full 6-way join.
  const needsCu = /\bcu\./.test(where);
  const needsAd = /\bad\./.test(where);
  const countJoin = `
    FROM tbl_job j
    ${needsCu ? 'LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id' : ''}
    ${needsAd ? 'LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id'  : ''}
  `;

  // Run COUNT and data query in parallel — they're independent, no reason to
  // serialize. Roughly halves wall-clock time on cold caches.
  const dataParams = [...params, Number(limit), Number(offset)];
  const [[[{ total }]], [rows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total ${countJoin} ${where}`, params),
    pool.query(
      `SELECT ${LIST_COLUMNS} ${LIST_JOIN} ${where}
       ORDER BY j.job_id DESC LIMIT ? OFFSET ?`,
      dataParams
    ),
  ]);
  return { rows, total };
}

// ─── Detail ─────────────────────────────────────────────────────────
/*
 * Fetches job detail + services + images in parallel. Each query is independent;
 * running them serially wastes ~2× the wall-clock time for zero benefit. The
 * main detail query is still the expensive one (7-way join); the other two are
 * cheap child lookups on indexed job_id.
 *
 * Returns null if the job row doesn't exist (preserved from prior behaviour).
 * Services + images default to [] if the main row is missing — no point paying
 * for those lookups when we're about to 404.
 */
async function getById(jobId) {
  const [jobRows, services, images] = await Promise.all([
    pool.query(
      `SELECT j.*,
              cu.customer_name, cu.customer_mob_no, cu.customer_email,
              ad.address, ad.building, ad.landmark, ad.locality, ad.pin_code,
              ad.gps_location, ad.city_id, ci.city_name,
              cl.client_name, cl.client_email,
              ef.efr_name AS easyfixer_name, ef.efr_no AS easyfixer_mobile,
              ow.user_name AS owner_name,
              cr.user_name AS created_by_name
       ${DETAIL_JOIN}
       WHERE j.job_id = ? LIMIT 1`,
      [jobId]
    ),
    pool.query(
      `SELECT js.job_service_id, js.service_id, js.quantity, js.total_charge,
              js.job_service_status, js.service_category_id, js.service_type_id,
              st.service_type_name, sc.service_catg_name
         FROM tbl_job_services js
         LEFT JOIN tbl_service_type st ON st.service_type_id = js.service_type_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = js.service_category_id
        WHERE js.job_id = ?
        ORDER BY js.job_service_id ASC`,
      [jobId]
    ),
    pool.query(
      `SELECT image_id, image, image_category, job_stage, created_date
         FROM tbl_job_image
        WHERE job_id = ?
        ORDER BY image_id ASC`,
      [jobId]
    ),
  ]);
  const job = jobRows[0][0];
  if (!job) return null;
  return { ...job, services: services[0], images: images[0] };
}

/*
 * Lightweight existence + status check. Used by setStatus / assign before they
 * mutate — skipping the 7-way join saves ~150-300ms per status change and
 * avoids loading services+images we don't use in those paths.
 */
async function getJobMeta(jobId) {
  const [[row]] = await pool.query(
    'SELECT job_id, job_status, fk_easyfixter_id, fk_customer_id, fk_client_id FROM tbl_job WHERE job_id = ? LIMIT 1',
    [jobId]
  );
  return row || null;
}

/*
 * Returns a single object with all status bucket totals + grand total, in ONE
 * DB round-trip. The dashboard used to make 6 separate /admin/jobs requests to
 * compute these — each of which ran a COUNT + data query in parallel server
 * side — causing ~12 concurrent pool connections for stats alone.
 *
 * Shape:
 *   { total, byStatus: { "0": 525, "1": 357, "2": 67, "3": 5702, "6": 65094, ... } }
 *
 * The grand total comes from the same query via a WITH ROLLUP or a small client
 * side sum — we use client-side sum because MySQL 5.7's WITH ROLLUP syntax is
 * fussy and the row count is always tiny (≤ 10 status codes).
 */
async function getStatusCounts() {
  /*
   * Two queries run in parallel:
   *   1. GROUP BY job_status — the raw count per code.
   *   2. BOOKED split by fk_easyfixter_id IS NULL — gives the dashboard the
   *      two derived buckets (Pending for Scheduling vs Pending App Ack) in
   *      one round-trip instead of a follow-up COUNT. Cheap on tbl_job
   *      because job_status is indexed and the filter is sargable.
   * Client-side sum for the grand total — easier than WITH ROLLUP on MySQL 5.7.
   */
  const [statusRows, bookedSplitRows] = await Promise.all([
    pool.query('SELECT job_status, COUNT(*) AS c FROM tbl_job GROUP BY job_status'),
    pool.query(
      `SELECT fk_easyfixter_id IS NULL AS unassigned, COUNT(*) AS c
         FROM tbl_job WHERE job_status = ${STATUS.BOOKED}
        GROUP BY unassigned`
    ),
  ]);
  const byStatus = {};
  let total = 0;
  for (const r of statusRows[0]) {
    byStatus[String(r.job_status)] = Number(r.c);
    total += Number(r.c);
  }
  let bookedUnassigned = 0;
  let bookedAssigned = 0;
  for (const r of bookedSplitRows[0]) {
    // mysql2 returns the BIT(1) from `IS NULL` as 0/1 int here (no typeCast
    // needed since it's a computed boolean, not a BIT column).
    if (Number(r.unassigned) === 1) bookedUnassigned = Number(r.c);
    else bookedAssigned = Number(r.c);
  }
  return { total, byStatus, bookedUnassigned, bookedAssigned };
}

// ─── Customer + Address helpers (used by create) ───────────────────
async function upsertCustomer(conn, { customer_id, customer_name, customer_mob_no, customer_email }, actor) {
  if (customer_id) {
    const [[found]] = await conn.query(
      'SELECT customer_id FROM tbl_customer WHERE customer_id = ? LIMIT 1',
      [customer_id]
    );
    if (!found) {
      const err = new Error(`customer_id ${customer_id} not found`);
      err.status = 400;
      throw err;
    }
    return customer_id;
  }
  // Lookup by mobile — reuse existing
  const [[existing]] = await conn.query(
    'SELECT customer_id FROM tbl_customer WHERE customer_mob_no = ? LIMIT 1',
    [customer_mob_no]
  );
  if (existing) return existing.customer_id;

  const [ins] = await conn.query(
    `INSERT INTO tbl_customer (customer_name, customer_mob_no, customer_email, is_active, created_by, insert_date, update_date)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    [customer_name, customer_mob_no, customer_email || null, actor?.user_id || null, new Date(), new Date()]
  );
  return ins.insertId;
}

async function insertAddress(conn, customerId, addr, actor) {
  const [ins] = await conn.query(
    `INSERT INTO tbl_address
       (customer_id, address, building, landmark, locality, city_id, pin_code, gps_location,
        mobile_number, created_by, insert_date, update_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      customerId,
      addr.address, addr.building || null, addr.landmark || null, addr.locality || null,
      addr.city_id, addr.pin_code, addr.gps_location || null,
      addr.mobile_number || null, actor?.user_id || null,
      new Date(), new Date(),
    ]
  );
  return ins.insertId;
}

// ─── Create ─────────────────────────────────────────────────────────
async function create(input, actor) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const customerId = await upsertCustomer(conn, input.customer, actor);

    let addressId = input.address?.address_id;
    if (!addressId) {
      addressId = await insertAddress(conn, customerId, input.address, actor);
    }

    const serviceTypeIds = Array.isArray(input.service_type_ids)
      ? input.service_type_ids.join(',')
      : (input.service_type_ids || null);

    const [ins] = await conn.query(
      `INSERT INTO tbl_job (
         job_desc, fk_customer_id, fk_address_id, fk_client_id,
         fk_service_type_id, fk_service_catg_id, service_type_ids,
         reporting_contact_id,
         requested_date_time, time_slot, created_date_time, ticket_created_date_time,
         fk_created_by, job_status, job_owner,
         job_type, source_type, client_ref_id, job_reference_id,
         job_customer_name, client_spoc, client_spoc_name, client_spoc_email,
         additional_name, additional_number,
         helper_req, remarks, last_update_time
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.job_desc || '', // job_desc is NOT NULL in tbl_job; default to empty string
        customerId, addressId, input.fk_client_id,
        input.fk_service_type_id || null, input.fk_service_catg_id || null, serviceTypeIds,
        input.reporting_contact_id || null,
        input.requested_date_time, input.time_slot || null, new Date(), new Date(),
        actor?.user_id || null, STATUS.BOOKED, input.job_owner || actor?.user_id || null,
        input.job_type || 'Installation', input.source_type || 'manual',
        input.client_ref_id || null, input.job_reference_id || null,
        input.customer?.customer_name || null,
        input.client_spoc || null, input.client_spoc_name || null, input.client_spoc_email || null,
        input.additional_name || null, input.additional_number || null,
        input.helper_req ? 1 : 0, input.remarks || null, new Date(),
      ]
    );
    const jobId = ins.insertId;

    if (Array.isArray(input.services) && input.services.length > 0) {
      // Single multi-row INSERT instead of N sequential round-trips. Only wins
      // for jobs with 3+ services but costs nothing for smaller sets.
      const values = input.services.map((svc) => [
        jobId, svc.service_id, svc.quantity || 1,
        svc.service_type_id || null, svc.service_category_id || null, 1,
      ]);
      await conn.query(
        `INSERT INTO tbl_job_services
           (job_id, service_id, quantity, service_type_id, service_category_id, job_service_status)
         VALUES ?`,
        [values]
      );
    }

    await conn.commit();

    /*
     * Flag-based auto-assignment on job creation.
     *
     * Setting: tbl_autoallocation_setting.running_frequency (per-client via
     * tbl_client_setting). Values:
     *   'instant'  → run the 3-layer pipeline now, assign the top candidate
     *   'schedule' (default) → do nothing; a daily batch picks it up instead
     *
     * Fire-and-forget via setImmediate so the create API returns the new
     * job row immediately — auto-assign happens in the background and
     * the subsequent assign() call takes care of status bump + scheduling
     * history + TechAssigned webhook + FCM push to the chosen technician.
     *
     * Errors are logged, not bubbled: a failed auto-assign should never
     * roll back a successfully-created job.
     */
    setImmediate(() => {
      tryAutoAssignOnCreate(jobId, input.fk_client_id, actor).catch((err) => {
        const logger = require('../logger');
        logger.warn(`Auto-assign on create failed for job ${jobId}: ${err.message}`);
      });
    });

    return getById(jobId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Update ─────────────────────────────────────────────────────────
const MUTABLE_COLUMNS = [
  'job_desc', 'job_type', 'source_type',
  'requested_date_time', 'time_slot', 'expected_date_time',
  'job_owner', 'fk_client_id', 'fk_service_type_id', 'fk_service_catg_id',
  'reporting_contact_id', 'client_spoc', 'client_spoc_name', 'client_spoc_email',
  'additional_name', 'additional_number',
  'client_ref_id', 'job_reference_id',
  'helper_req', 'remarks', 'efr_special_notes',
  'exp_tat', 'booking_cut_off_time', 'booking_cut_off_time_slot',
];

async function update(jobId, input, actor) {
  const existing = await getById(jobId);
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  const sets = [];
  const values = [];
  for (const col of MUTABLE_COLUMNS) {
    if (input[col] !== undefined) {
      sets.push(`${col} = ?`);
      values.push(input[col]);
    }
  }
  if (sets.length === 0) return existing;

  sets.push('last_update_time = ?');
  values.push(new Date());
  values.push(jobId);

  await pool.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, values);
  return getById(jobId);
}

// ─── Webhook + notification firing (fire-and-forget) ────────────────
// Lazy-require avoids circular dependency.
function fireWebhook(eventName, jobId) {
  try {
    const { dispatch } = require('./webhook.service');
    dispatch({ eventName, jobId }).catch((err) =>
      require('../logger').warn({ eventName, jobId, err: err.message }, 'webhook dispatch error'));
  } catch (err) {
    require('../logger').warn({ eventName, jobId, err: err.message }, 'webhook wiring error');
  }
  // Also fire the notification orchestrator (inbox + SMS/email/WA)
  fireNotification(eventName, jobId);
}

function fireNotification(eventName, jobId) {
  setImmediate(async () => {
    try {
      const job = await getById(jobId);
      if (!job) return;
      const { onJobEvent } = require('./notification-orchestrator.service');
      await onJobEvent(eventName, job);
    } catch (err) {
      require('../logger').warn({ eventName, jobId, err: err.message }, 'notification orchestrator wiring error');
    }
  });
}

function statusToEventName(prevStatus, newStatus) {
  // Map tbl_job.job_status transition → webhook event name.
  if (newStatus === STATUS.IN_PROGRESS)   return 'TechStart';
  if (COMPLETED_STATES.has(newStatus))    return 'TechVisitComplete';
  if (newStatus === STATUS.CANCELLED)     return 'CancelJob';
  if (newStatus === STATUS.REVISIT)       return 'TechVisitInComplete';
  return null;
}

// ─── Status change ──────────────────────────────────────────────────
/*
 * Performance notes:
 *   - Use getJobMeta (single row, no joins) for the existence + prev-status
 *     check instead of the full getById. Saves one 7-way-join + services + images
 *     fetch per status change (the caller gets the fresh state below).
 *   - Webhook + notification dispatch is fire-and-forget via setImmediate inside
 *     fireWebhook, so the HTTP response returns as soon as UPDATE commits.
 */
async function setStatus(jobId, { status, reasonId, comment }, actor) {
  if (!ALL_STATUS_VALUES.has(Number(status))) {
    const err = new Error(`invalid status ${status}; allowed: ${[...ALL_STATUS_VALUES].join(',')}`);
    err.status = 400; throw err;
  }
  const existing = await getJobMeta(jobId);
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }

  const sets = ['job_status = ?', 'last_update_time = ?'];
  const values = [status, new Date()];
  const actorId = actor?.user_id || null;

  if (Number(status) === STATUS.CANCELLED) {
    sets.push('cancel_date_time = ?', 'cancel_reason_id = ?', 'cancel_comment = ?', 'cancel_by = ?');
    values.push(new Date(), reasonId || null, comment || null, actorId);
  } else if (COMPLETED_STATES.has(Number(status))) {
    sets.push('checkout_date_time = COALESCE(checkout_date_time, ?)', 'fk_checkout_by = COALESCE(fk_checkout_by, ?)');
    values.push(new Date(), actorId);
  }

  values.push(jobId);
  await pool.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, values);

  const eventName = statusToEventName(existing.job_status, Number(status));
  if (eventName) fireWebhook(eventName, jobId);

  return getById(jobId);
}

// ─── Assign / Reassign technician ───────────────────────────────────
async function assign(jobId, { easyfixerId, reasonId, rescheduleReason }, actor) {
  // Check tech + job in parallel — they're independent lookups. Fails either
  // way with the right 400/404, same as before, but cuts one round-trip.
  const [[[tech]], existing] = await Promise.all([
    pool.query(
      'SELECT efr_id, efr_status FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
      [easyfixerId]
    ),
    getJobMeta(jobId),
  ]);
  if (!tech) {
    const err = new Error(`easyfixer ${easyfixerId} not found`); err.status = 400; throw err;
  }
  if (!tech.efr_status) {
    const err = new Error(`easyfixer ${easyfixerId} is inactive`); err.status = 400; throw err;
  }
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const isReassign = existing.fk_easyfixter_id && existing.fk_easyfixter_id !== easyfixerId;
    const now = new Date();

    await conn.query(
      `UPDATE tbl_job
          SET fk_easyfixter_id = ?, scheduled_date_time = ?, fk_scheduled_by = ?,
              job_status = CASE WHEN job_status = ${STATUS.BOOKED} THEN ${STATUS.SCHEDULED} ELSE job_status END,
              first_scheduled_by = COALESCE(first_scheduled_by, ?),
              last_update_time = ?
        WHERE job_id = ?`,
      [easyfixerId, now, actor?.user_id || null, actor?.user_id || null, now, jobId]
    );

    await conn.query(
      `INSERT INTO scheduling_history (job_id, easyfixer_id, schedule_time, reason_id, reschedule_reason)
       VALUES (?, ?, ?, ?, ?)`,
      [jobId, easyfixerId, now,
       isReassign ? (reasonId || null) : null,
       isReassign ? (rescheduleReason || null) : null]
    );

    await conn.commit();

    fireWebhook(isReassign ? 'RescheduleTech' : 'TechAssigned', jobId);

    return getById(jobId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Change job owner (PM reassignment) ─────────────────────────────
// Distinct from /assign (which sets fk_easyfixter_id — the technician).
// This endpoint changes job_owner (the internal PM/user who runs the job).
// Always captures reason + timestamp + actor for the audit trail.
async function changeOwner(jobId, { newOwnerId, reason }, actor) {
  // Skip the full detail load — we only need job_owner for the no-op check.
  const [[existing]] = await pool.query(
    'SELECT job_id, job_owner FROM tbl_job WHERE job_id = ? LIMIT 1',
    [jobId]
  );
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  if (existing.job_owner === newOwnerId) {
    const err = new Error(`job ${jobId} is already owned by user ${newOwnerId}`);
    err.status = 400; throw err;
  }

  // Validate target user exists, is active, and is an admin-group user.
  // (A client SPOC or technician can't own a CRM job.)
  const { classifyRoleIdSync } = require('./role.service');
  const [[target]] = await pool.query(
    `SELECT user_id, user_name, user_role, user_status FROM tbl_user WHERE user_id = ? LIMIT 1`,
    [newOwnerId]
  );
  if (!target) {
    const err = new Error(`target user ${newOwnerId} not found`); err.status = 400; throw err;
  }
  if (!target.user_status) {
    const err = new Error(`target user ${newOwnerId} is inactive`); err.status = 400; throw err;
  }
  const targetGroup = classifyRoleIdSync(target.user_role);
  if (targetGroup !== 'admin') {
    const err = new Error(`target user ${newOwnerId} is not in admin group (got "${targetGroup}")`);
    err.status = 400; throw err;
  }

  await pool.query(
    `UPDATE tbl_job
        SET job_owner = ?,
            job_owner_change_by = ?,
            owner_change_reason = ?,
            owner_change_date = ?,
            last_update_time = ?
      WHERE job_id = ?`,
    [newOwnerId, actor?.user_id || null, reason, new Date(), new Date(), jobId]
  );

  return getById(jobId);
}

/*
 * Invoked from create() via setImmediate when a new job is committed.
 * Reads tbl_autoallocation_setting.running_frequency (with per-client override
 * in tbl_client_setting) and, if 'instant', runs the auto-assign pipeline.
 * The actual assignment (including TechAssigned webhook + FCM push to the
 * chosen tech) is handled by auto-assign.service.js::assignTopCandidate(),
 * which calls our assign() above — so the full lifecycle (status bump,
 * scheduling_history row, notification fan-out) fires identically to a manual
 * assign by a human operator.
 */
async function tryAutoAssignOnCreate(jobId, clientId, actor) {
  const logger = require('../logger');
  const { getClientSetting } = require('./settings.service');
  const freq = await getClientSetting(clientId, 'running_frequency');
  if (freq !== 'instant') {
    logger.debug(`Auto-assign skipped for job ${jobId} — running_frequency=${freq ?? 'unset'}`);
    return;
  }
  const { assignTopCandidate } = require('./auto-assign.service');
  try {
    const result = await assignTopCandidate(jobId, actor);
    // A truthy `result.chosen` means `jobService.assign()` already committed
    // the transaction, so the job + scheduling_history row are safely persisted.
    // No email needed — downstream fan-out (webhook + FCM) is fire-and-forget
    // and has its own retry/DLQ plumbing. Per product: "Once auto assigned in
    // DB and status is saved, it's fine."
    if (result?.chosen) {
      logger.ready(`Auto-assigned job ${jobId} → ${result.chosen.efr_name} (efr_id=${result.chosen.efr_id}, score=${result.chosen.score})`);
      return;
    }
    // Defensive branch — assignTopCandidate should throw 422 on no-candidates
    // rather than return an empty result, but belt-and-braces.
    logger.warn(`Auto-assign found no eligible candidates for job ${jobId} — manual assignment required`);
    await notifyAutoAssignFailure(jobId, clientId, 'No eligible technician was found for this job.');
  } catch (err) {
    /*
     * Classify failures so the ops email conveys WHY nothing got assigned.
     * Categories we surface:
     *   422 → No eligible candidate (L1/L2 rejected everyone).
     *   404 → Job vanished between create + auto-assign (extremely rare).
     *   409 → Someone else assigned the job in the interval (manual operator
     *          won the race). This is NOT a failure — just log and skip email.
     *   other → DB save error, inactive efr, unexpected exception. Ops need
     *           to act because the job is still BOOKED with no tech.
     */
    if (err.status === 409) {
      logger.info(`Auto-assign skipped for job ${jobId} — already assigned (likely manual race): ${err.message}`);
      return;
    }
    const reason =
      err.status === 422 ? 'No eligible technician was found for this job.' :
      err.status === 404 ? `Job could not be resolved (${err.message}).` :
      `Auto-assignment errored before the technician could be saved: ${err.message}`;
    logger.warn(`Auto-assign failed for job ${jobId}: ${err.message} (status=${err.status ?? 'unknown'})`);
    await notifyAutoAssignFailure(jobId, clientId, reason);
  }
}

/*
 * Sends an ops-style email when auto-assignment couldn't fulfil a job so a
 * human can pick up the slack. Email recipient is a configurable setting
 * (auto_assign_failure_email) with per-client override — same EAV plumbing
 * as running_frequency. If no email is configured, the notification is
 * silently skipped (ops can always check the job list for unassigned BOOKED
 * rows). Never throws — failure email failures are just logged.
 */
async function notifyAutoAssignFailure(jobId, clientId, reason) {
  const logger = require('../logger');
  try {
    const { getClientSetting } = require('./settings.service');
    const to = await getClientSetting(clientId, 'auto_assign_failure_email');
    if (!to) { logger.debug(`Auto-assign failure notification skipped — no email configured (job ${jobId})`); return; }

    const job = await getById(jobId);
    const lines = [
      `Auto-assignment did not complete for job #${jobId} — the job has NOT been assigned to a technician.`,
      `Reason: ${reason}`,
      '',
      `Client: ${job?.client_name ?? 'unknown'}`,
      `Customer: ${job?.customer_name ?? 'unknown'} · ${job?.customer_mob_no ?? ''}`,
      `City: ${job?.city_name ?? 'unknown'}`,
      `Type: ${job?.job_type ?? ''}`,
      `Requested: ${job?.requested_date_time ?? ''}`,
      '',
      `The job is currently in BOOKED status and needs manual assignment.`,
    ].join('\n');

    const { send } = require('./email.service');
    await send({
      to,
      subject: `[Auto-assign] Job #${jobId} not assigned — manual action needed`,
      text: lines,
      category: 'transactional',
    });
    logger.info(`Auto-assign failure notification sent to ${to} for job ${jobId}`);
  } catch (err) {
    logger.warn(`Failed to send auto-assign failure email for job ${jobId}: ${err.message}`);
  }
}

module.exports = {
  STATUS, ALL_STATUS_VALUES, MUTABLE_COLUMNS,
  list, getById, getStatusCounts, create, update, setStatus, assign, changeOwner,
  tryAutoAssignOnCreate,
  fireWebhook, statusToEventName,
};
