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
const STATUS = {
  BOOKED: 0, SCHEDULED: 1, IN_PROGRESS: 2,
  COMPLETED: 3, COMPLETED_ALT: 5, CANCELLED: 6,
  ENQUIRY: 7, CALL_LATER: 9, REVISIT: 10,
};
const ALL_STATUS_VALUES = new Set(Object.values(STATUS));

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

const DETAIL_JOIN = `
  FROM tbl_job j
  LEFT JOIN tbl_customer    cu ON cu.customer_id = j.fk_customer_id
  LEFT JOIN tbl_address     ad ON ad.address_id  = j.fk_address_id
  LEFT JOIN tbl_city        ci ON ci.city_id     = ad.city_id
  LEFT JOIN tbl_client      cl ON cl.client_id   = j.fk_client_id
  LEFT JOIN tbl_easyfixer   ef ON ef.efr_id      = j.fk_easyfixter_id
  LEFT JOIN tbl_user        ow ON ow.user_id     = j.job_owner
  LEFT JOIN tbl_user        cr ON cr.user_id     = j.fk_created_by
`;

// ─── List ───────────────────────────────────────────────────────────
async function list({
  q, status, clientId, cityId, ownerId, easyfixerId,
  startDate, endDate,
  limit = 50, offset = 0,
} = {}) {
  const clauses = [];
  const params = [];

  if (status != null) {
    clauses.push('j.job_status = ?');
    params.push(status);
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

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total ${DETAIL_JOIN} ${where}`,
    params
  );

  params.push(Number(limit), Number(offset));
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS} ${DETAIL_JOIN} ${where}
     ORDER BY j.job_id DESC LIMIT ? OFFSET ?`,
    params
  );
  return { rows, total };
}

// ─── Detail ─────────────────────────────────────────────────────────
async function getById(jobId) {
  const [[job]] = await pool.query(
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
  );
  if (!job) return null;

  const [services] = await pool.query(
    `SELECT js.job_service_id, js.service_id, js.quantity, js.total_charge,
            js.job_service_status, js.service_category_id, js.service_type_id,
            st.service_type_name, sc.service_catg_name
       FROM tbl_job_services js
       LEFT JOIN tbl_service_type st ON st.service_type_id = js.service_type_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = js.service_category_id
      WHERE js.job_id = ?
      ORDER BY js.job_service_id ASC`,
    [jobId]
  );

  const [images] = await pool.query(
    `SELECT image_id, image, image_category, job_stage, created_date
       FROM tbl_job_image
      WHERE job_id = ?
      ORDER BY image_id ASC`,
    [jobId]
  );

  return { ...job, services, images };
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
      for (const svc of input.services) {
        await conn.query(
          `INSERT INTO tbl_job_services
             (job_id, service_id, quantity, service_type_id, service_category_id, job_service_status)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [jobId, svc.service_id, svc.quantity || 1, svc.service_type_id || null, svc.service_category_id || null]
        );
      }
    }

    await conn.commit();
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
async function setStatus(jobId, { status, reasonId, comment }, actor) {
  if (!ALL_STATUS_VALUES.has(Number(status))) {
    const err = new Error(`invalid status ${status}; allowed: ${[...ALL_STATUS_VALUES].join(',')}`);
    err.status = 400; throw err;
  }
  const existing = await getById(jobId);
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
  const [[tech]] = await pool.query(
    'SELECT efr_id, efr_status FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
    [easyfixerId]
  );
  if (!tech) {
    const err = new Error(`easyfixer ${easyfixerId} not found`); err.status = 400; throw err;
  }
  if (!tech.efr_status) {
    const err = new Error(`easyfixer ${easyfixerId} is inactive`); err.status = 400; throw err;
  }

  const existing = await getById(jobId);
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
  const existing = await getById(jobId);
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

module.exports = {
  STATUS, ALL_STATUS_VALUES, MUTABLE_COLUMNS,
  list, getById, create, update, setStatus, assign, changeOwner,
  fireWebhook, statusToEventName,
};
