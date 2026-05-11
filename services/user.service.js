const { pool } = require('../db');
const roleService = require('./role.service');

/*
 * Manage Users — internal-staff CRUD on tbl_user.
 *
 * Mirrors the cities service in shape (list/get/create/update/deactivate +
 * sortable-column whitelist + mkErr helper). The big behavioural rule:
 *
 *   Internal-user gate (user_type_id = 5)
 *   ─────────────────────────────────────
 *   The CRM only manages user_type_id = 5 — internal staff. The legacy DB
 *   carries other user_type_ids (clients, technicians ghosts, etc.) and the
 *   auth flow in services/auth.service.js already enforces this gate at OTP
 *   issuance. We mirror it here so an Admin can never accidentally create or
 *   list a row that wouldn't actually be loginable.
 *
 * Soft-delete only — tbl_user is referenced by tbl_job.fk_created_by,
 * tbl_job.fk_scheduled_by, audit columns across the schema, and historical
 * tbl_easyfixer assignments. Hard-delete would break joins on five legacy
 * services. Deactivating sets user_status = 0; reactivation flips it back.
 *
 * NO PASSWORD COLUMN — confirmed in CLAUDE.md and the auth service. Auth is
 * OTP-only (email or mobile → 4-digit OTP). This service therefore takes
 * no password input on create/update; that surface doesn't exist.
 */

const INTERNAL_USER_TYPE_ID = 5;
const STATUS_ACTIVE = 1;

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

/*
 * Sortable-column whitelist. Same SQL-injection guardrail as cities — only
 * keys in this map can land in ORDER BY. Computed/joined columns (role_name,
 * city_name) work because MySQL resolves SELECT aliases inside ORDER BY.
 */
const SORTABLE_COLUMNS = Object.freeze({
  user_id:        'u.user_id',
  user_name:      'u.user_name',
  official_email: 'u.official_email',
  mobile_no:      'u.mobile_no',
  role_name:      'r.role_name',
  city_name:      'c.city_name',
  user_status:    'u.user_status',
  insert_date:    'u.insert_date',
});

const MUTABLE_COLUMNS = Object.freeze([
  // user_name / official_email NOT included — legacy CRM treats them as
  // read-only post-create (addEditUser.vm has them as RO fields). They feed
  // OTP delivery; changing them mid-flight can lock a user out of their
  // own account. If renaming becomes a real ops need, add a dedicated
  // "transfer ownership" flow rather than a plain UPDATE.
  'mobile_no', 'alternate_no', 'user_role', 'city_id',
  'manage_clients', 'manage_cities', 'manage_states',
]);

// ─── List ────────────────────────────────────────────────────────────
async function listUsers({
  q, roleId, cityId, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'user_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit)  || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.user_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // Stable secondary sort on user_id — guarantees deterministic pagination
  // when the primary key has duplicates (very common on role_name).
  const orderBy  = `${sortExpr} ${dir}, u.user_id ASC`;

  const where  = [`u.user_type_id = ${INTERNAL_USER_TYPE_ID}`];
  const params = [];
  if (!includeInactive) where.push('u.user_status = 1');
  if (q) {
    where.push('(u.user_name LIKE ? OR u.official_email LIKE ? OR u.mobile_no LIKE ? OR u.user_code LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (roleId) { where.push('u.user_role = ?'); params.push(Number(roleId)); }
  if (cityId) { where.push('u.city_id = ?');   params.push(Number(cityId)); }

  const [rows] = await pool.query(
    `SELECT
        u.user_id, u.user_code, u.user_name, u.official_email, u.mobile_no,
        u.alternate_no, u.user_role, r.role_name,
        u.city_id, c.city_name,
        u.manage_clients, u.manage_cities, u.manage_states,
        u.user_status, u.insert_date, u.update_date
       FROM tbl_user  u
       LEFT JOIN tbl_role r ON r.role_id = u.user_role
       LEFT JOIN tbl_city c ON c.city_id = u.city_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_user u WHERE ${where.join(' AND ')}`,
    params
  );

  return { items: rows, total };
}

async function getUserById(userId) {
  const [[row]] = await pool.query(
    `SELECT u.user_id, u.user_code, u.user_name, u.official_email, u.mobile_no,
            u.alternate_no, u.user_role, r.role_name,
            u.city_id, c.city_name,
            u.manage_clients, u.manage_cities, u.manage_states,
            u.user_status, u.insert_date, u.update_date, u.updated_by
       FROM tbl_user  u
       LEFT JOIN tbl_role r ON r.role_id = u.user_role
       LEFT JOIN tbl_city c ON c.city_id = u.city_id
      WHERE u.user_id = ? AND u.user_type_id = ?
      LIMIT 1`,
    [userId, INTERNAL_USER_TYPE_ID]
  );
  return row || null;
}

// ─── Create ──────────────────────────────────────────────────────────
/*
 * Uniqueness rules — enforced in app code, not in DB. tbl_user has no
 * unique key on email or mobile (legacy has duplicates), so we do a
 * "no active duplicate" pre-check before INSERT. Inactive duplicates are
 * tolerated — they represent ex-staff whose row we soft-deleted but kept
 * for audit FKs. If a new joiner has the same email/mobile as an inactive
 * row, the operator should reactivate that row instead.
 */
async function createUser({
  user_name, official_email, mobile_no, user_role,
  city_id, alternate_no, manage_clients, manage_cities, manage_states,
  createdBy,
}) {
  const name  = String(user_name || '').trim();
  const email = String(official_email || '').trim().toLowerCase();
  const mob   = String(mobile_no || '').trim();
  if (!name)  throw mkErr(400, 'user_name is required');
  if (!email) throw mkErr(400, 'official_email is required');
  if (!mob)   throw mkErr(400, 'mobile_no is required');
  if (!user_role) throw mkErr(400, 'user_role is required');

  // Validate role exists + is admin-group (we don't manage technicians or
  // client-dashboard users here — those have their own lifecycles).
  const role = await roleService.getRoleById(user_role);
  if (!role)           throw mkErr(400, `Unknown role_id ${user_role}`);
  if (role.group !== 'admin')
    throw mkErr(400, `Role "${role.role_name}" is not an admin role and can't be assigned to a CRM user`);

  const [[dupEmail]] = await pool.query(
    `SELECT user_id FROM tbl_user
      WHERE LOWER(official_email) = ? AND user_status = 1 AND user_type_id = ?
      LIMIT 1`,
    [email, INTERNAL_USER_TYPE_ID]
  );
  if (dupEmail) throw mkErr(409, `An active user with email "${email}" already exists`);

  const [[dupMob]] = await pool.query(
    `SELECT user_id FROM tbl_user
      WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ?
      LIMIT 1`,
    [mob, INTERNAL_USER_TYPE_ID]
  );
  if (dupMob) throw mkErr(409, `An active user with mobile "${mob}" already exists`);

  const [r] = await pool.query(
    `INSERT INTO tbl_user
       (user_name, official_email, mobile_no, alternate_no,
        user_role, user_type_id, city_id,
        manage_clients, manage_cities, manage_states,
        user_status, insert_date, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
    [
      name, email, mob, alternate_no || null,
      Number(user_role), INTERNAL_USER_TYPE_ID, city_id ? Number(city_id) : null,
      manage_clients || null, manage_cities || null, manage_states || null,
      STATUS_ACTIVE, createdBy || null,
    ]
  );
  return getUserById(r.insertId);
}

// ─── Update ──────────────────────────────────────────────────────────
async function updateUser(userId, fields, updatedBy) {
  // Confirm target exists + is internal — keeps callers from accidentally
  // editing a client/technician row through this endpoint.
  const [[me]] = await pool.query(
    'SELECT user_id, user_type_id FROM tbl_user WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (!me) throw mkErr(404, 'User not found');
  if (me.user_type_id !== INTERNAL_USER_TYPE_ID) {
    throw mkErr(403, 'This user is not an internal CRM user and can\'t be edited here');
  }

  const sets   = [];
  const params = [];

  for (const key of MUTABLE_COLUMNS) {
    if (fields[key] === undefined) continue;
    let val = fields[key];
    if (key === 'user_role' && val) {
      const role = await roleService.getRoleById(val);
      if (!role) throw mkErr(400, `Unknown role_id ${val}`);
      if (role.group !== 'admin') {
        throw mkErr(400, `Role "${role.role_name}" is not an admin role`);
      }
      val = Number(val);
    }
    if (key === 'mobile_no' && val) {
      const mob = String(val).trim();
      const [[dup]] = await pool.query(
        `SELECT user_id FROM tbl_user
          WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ?
            AND user_id <> ? LIMIT 1`,
        [mob, INTERNAL_USER_TYPE_ID, userId]
      );
      if (dup) throw mkErr(409, `Another active user already uses mobile "${mob}"`);
      val = mob;
    }
    sets.push(`${key} = ?`);
    params.push(val === '' ? null : val);
  }

  if (fields.is_active !== undefined) {
    sets.push('user_status = ?');
    params.push(fields.is_active ? 1 : 0);
  }

  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  sets.push('update_date = NOW()', 'updated_by = ?');
  params.push(updatedBy || null, userId);

  await pool.query(`UPDATE tbl_user SET ${sets.join(', ')} WHERE user_id = ?`, params);
  return getUserById(userId);
}

// ─── Soft-delete (status flag) ──────────────────────────────────────
async function deactivateUser(userId, updatedBy) {
  const [r] = await pool.query(
    `UPDATE tbl_user
        SET user_status = 0, update_date = NOW(), updated_by = ?
      WHERE user_id = ? AND user_type_id = ?`,
    [updatedBy || null, userId, INTERNAL_USER_TYPE_ID]
  );
  return r.affectedRows > 0;
}

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deactivateUser,
  SORTABLE_COLUMNS,
  INTERNAL_USER_TYPE_ID,
};
