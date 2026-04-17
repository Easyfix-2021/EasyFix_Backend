const { pool } = require('../db');

/*
 * Easyfixer (technician) CRUD.
 *
 * Important notes about the live table (2026-04-17):
 *   - tbl_easyfixer has 86 columns. We expose a curated projection in list
 *     responses (~14 cols) and a fuller one in detail responses. Never return
 *     the raw SELECT * on lists — the payload size hurts perf.
 *   - efr_no (mobile) is the business identifier BUT is NOT enforced unique
 *     at the DB level. Duplicates exist in production data. We detect active
 *     duplicates on create and return 409; we do not block updates.
 *   - Several column names drift from the blueprint; the DB is authoritative.
 *     See CLAUDE.md "Table-name reconciliations" + easyfixer glossary.
 *
 * All queries parameterised. Status toggles use soft-delete semantics —
 * we flip efr_status, never DELETE.
 */

// ─── Projections ────────────────────────────────────────────────────
const LIST_COLUMNS = `
  e.efr_id, e.efr_name, e.efr_first_name, e.efr_last_name,
  e.efr_no, e.efr_email, e.efr_cityId, c.city_name AS city_name,
  e.efr_status, e.efr_service_category, e.efr_service_type,
  e.efr_profile_perc, e.is_technician_verified,
  e.efr_manager_id, e.insert_date, e.update_date
`;

const DETAIL_COLUMNS = `
  e.*,
  c.city_name AS city_name
`;

// ─── List ───────────────────────────────────────────────────────────
async function list({
  q, cityId, serviceCategory, isVerified, status,
  limit = 50, offset = 0, includeInactive = false,
} = {}) {
  const clauses = [];
  const params = [];

  if (!includeInactive && status == null) clauses.push('e.efr_status = 1');
  if (status === 0 || status === 1) {
    clauses.push('e.efr_status = ?');
    params.push(status);
  }
  if (q) {
    clauses.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (cityId != null) {
    clauses.push('e.efr_cityId = ?');
    params.push(cityId);
  }
  if (serviceCategory) {
    clauses.push('e.efr_service_category LIKE ?');
    params.push(`%${serviceCategory}%`);
  }
  if (isVerified === true)  clauses.push('e.is_technician_verified = 1');
  if (isVerified === false) clauses.push('(e.is_technician_verified = 0 OR e.is_technician_verified IS NULL)');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Page + total count for client pagination UI
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_easyfixer e ${where}`,
    params
  );

  params.push(Number(limit), Number(offset));
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS}
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
       ${where}
       ORDER BY e.efr_id DESC
       LIMIT ? OFFSET ?`,
    params
  );
  return { rows, total };
}

// ─── Detail ─────────────────────────────────────────────────────────
async function getById(id) {
  const [[row]] = await pool.query(
    `SELECT ${DETAIL_COLUMNS}
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_id = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

// ─── Create ─────────────────────────────────────────────────────────
async function findActiveByMobile(efrNo) {
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_name FROM tbl_easyfixer
      WHERE efr_no = ? AND efr_status = 1 LIMIT 1`,
    [efrNo]
  );
  return row || null;
}

const MUTABLE_COLUMNS = [
  'efr_name', 'efr_first_name', 'efr_last_name',
  'efr_no', 'efr_alt_no', 'efr_email',
  'efr_address', 'efr_address_res', 'efr_building', 'efr_landmark',
  'efr_pin_no', 'efr_cityId', 'efr_zone_city_id',
  'efr_base_gps', 'efr_current_gps',
  'efr_type', 'efr_service_category', 'efr_service_type',
  'efr_manager_id', 'efr_marital_status', 'efr_children', 'efr_age',
  'efr_profile_img', 'about_yourself',
  'adhaar_card_number', 'pan_card_number',
  'date_of_birth', 'efr_tools',
  'skill', 'skill_rating', 'tool_rating',
  'health_insurance', 'accidental_insurance', 'have_driving_lisence', 'have_bike',
  'use_whatsapp',
  'is_technician_verified', 'is_email_verified',
  'experience_id', 'user_id',
];

async function create(input, actor) {
  const existing = await findActiveByMobile(input.efr_no);
  if (existing) {
    const err = new Error(`an active easyfixer with efr_no=${input.efr_no} already exists (efr_id=${existing.efr_id})`);
    err.status = 409;
    err.details = { existingId: existing.efr_id };
    throw err;
  }

  const columns = [];
  const values = [];
  for (const col of MUTABLE_COLUMNS) {
    if (input[col] !== undefined) {
      columns.push(col);
      values.push(input[col]);
    }
  }
  // Audit + defaults
  columns.push('efr_status', 'inserted_by', 'insert_date', 'update_date');
  values.push(1, actor?.user_id || null, new Date(), new Date());

  const placeholders = columns.map(() => '?').join(', ');
  const [result] = await pool.query(
    `INSERT INTO tbl_easyfixer (${columns.join(', ')}) VALUES (${placeholders})`,
    values
  );
  return getById(result.insertId);
}

// ─── Update ─────────────────────────────────────────────────────────
async function update(id, input, actor) {
  const existing = await getById(id);
  if (!existing) {
    const err = new Error('easyfixer not found');
    err.status = 404;
    throw err;
  }

  const sets = [];
  const values = [];
  for (const col of MUTABLE_COLUMNS) {
    if (input[col] !== undefined) {
      sets.push(`${col} = ?`);
      values.push(input[col]);
    }
  }
  if (sets.length === 0) return existing; // nothing to change

  sets.push('updated_by = ?', 'update_date = ?');
  values.push(actor?.user_id || null, new Date());
  values.push(id);

  await pool.query(
    `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`,
    values
  );
  return getById(id);
}

// ─── Status toggle ──────────────────────────────────────────────────
async function setStatus(id, { active, reasonId, comment }, actor) {
  const existing = await getById(id);
  if (!existing) {
    const err = new Error('easyfixer not found');
    err.status = 404;
    throw err;
  }

  const sets = ['efr_status = ?', 'updated_by = ?', 'update_date = ?'];
  const values = [active ? 1 : 0, actor?.user_id || null, new Date()];

  if (active === false) {
    sets.push('inactive_reason = ?', 'inactive_comment = ?', 'last_inactive_date_time = ?');
    values.push(reasonId || null, comment || null, new Date());
  } else {
    // Reactivation: clear inactivity reason fields
    sets.push('inactive_reason = NULL', 'inactive_comment = NULL');
  }

  values.push(id);
  await pool.query(
    `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`,
    values
  );
  return getById(id);
}

module.exports = {
  list,
  getById,
  create,
  update,
  setStatus,
  findActiveByMobile,
  MUTABLE_COLUMNS,
};
