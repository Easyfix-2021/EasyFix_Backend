const { pool } = require('../db');
const logger = require('../logger');

/*
 * Role classification — maps tbl_role.role_id → one of:
 *   'admin'   internal staff with CRM privileges (mounts /api/admin/*)
 *   'client'  client SPOC dashboard user (mounts /api/client/*)
 *   'mobile'  technician / easyfixer (mounts /api/mobile/*)
 *   'default' Default User — no group membership yet
 *   'unknown' role exists but isn't classified (fail-closed in middleware)
 *
 * Source of truth: tbl_role as observed 2026-04-17 (20 rows, 8 active).
 * Two legacy quirks to note:
 *   - role_id 19 "Technician" has 4,753 rows in tbl_user. Technicians officially
 *     live in tbl_easyfixer; those tbl_user rows appear to be ghost/duplicate
 *     records. We still classify 19 as 'mobile' to keep the mapping complete.
 *   - role_ids 20 and 21 are near-duplicate client roles ("Client Dashboard User"
 *     vs "ClientDashboard User"). Both map to 'client'.
 *
 * If a new role_id appears that isn't listed here, it classifies as 'unknown'
 * and role middleware denies it. Prefer adding it here over broadening the
 * middleware default.
 */
const ROLE_ID_TO_GROUP = {
  1: 'default',   // Default User
  2: 'admin',     // Admin
  3: 'admin',     // Executive Supply
  4: 'admin',     // Call Flow (inactive but kept mapped)
  5: 'admin',     // Business Development
  7: 'admin',     // Finance
  11: 'admin',    // Call Flow + Quality
  12: 'admin',    // Zonal Field Team
  13: 'admin',    // Project Manager
  15: 'admin',    // Admin Supply
  17: 'admin',    // Solution expert
  18: 'admin',    // Technology team
  19: 'mobile',   // Technician
  20: 'client',   // Client Dashboard User
  21: 'client',   // ClientDashboard User (duplicate)
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { loadedAt: 0, byId: new Map() };
let loading = null;

/*
 * Parse the legacy CSV menu_ids string into a sorted unique int array.
 * Tolerant of nulls, whitespace, trailing commas, and non-numeric junk —
 * legacy data is messy enough that strict parsing would lose roles.
 */
function parseMenuIdsCsv(raw) {
  if (raw == null) return [];
  return Array.from(new Set(
    String(raw)
      .split(',')
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  )).sort((a, b) => a - b);
}

async function loadRoles() {
  const [rows] = await pool.query(
    'SELECT role_id, role_name, role_desc, role_status, menu_ids FROM tbl_role'
  );
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.role_id, {
      role_id: row.role_id,
      role_name: row.role_name,
      role_desc: row.role_desc,
      role_status: row.role_status === 1 || row.role_status === true,
      menu_ids: parseMenuIdsCsv(row.menu_ids),
      group: ROLE_ID_TO_GROUP[row.role_id] ?? 'unknown',
    });
  }
  cache = { loadedAt: Date.now(), byId };
  logger.debug({ count: byId.size }, 'role cache refreshed');
  return cache;
}

async function ensureCache() {
  if (Date.now() - cache.loadedAt < CACHE_TTL_MS && cache.byId.size > 0) {
    return cache;
  }
  if (loading) return loading;
  loading = loadRoles().finally(() => { loading = null; });
  return loading;
}

async function getRoleById(roleId) {
  if (roleId == null) return null;
  await ensureCache();
  return cache.byId.get(Number(roleId)) || null;
}

function classifyRoleIdSync(roleId) {
  return ROLE_ID_TO_GROUP[Number(roleId)] ?? 'unknown';
}

async function refreshCache() {
  return loadRoles();
}

// ─── Manage Roles — CRUD ─────────────────────────────────────────────
/*
 * The CRUD surface below powers the Manage Roles settings screen. It runs
 * against tbl_role directly and busts the 5-min classification cache on
 * every successful write so the role middleware sees the change on the
 * next request.
 *
 * Group classification is read-only from this surface — adding a new
 * role_id requires editing the ROLE_ID_TO_GROUP map above. Reason: groups
 * gate route mounts (/api/admin vs /api/client), so a misclassification
 * is a security event. We don't let it be set from a UI form.
 *
 * Soft-delete only — tbl_role is referenced by tbl_user.user_role (FK)
 * and by middleware classification. Hard-deleting orphans every user row
 * assigned to that role.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  role_id:     'r.role_id',
  role_name:   'r.role_name',
  role_desc:   'r.role_desc',
  role_status: 'r.role_status',
  user_count:  'user_count',
});

async function listRoles({
  q, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'role_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit)  || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.role_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, r.role_id ASC`;

  const where  = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('r.role_status = 1');
  if (q) {
    where.push('(r.role_name LIKE ? OR r.role_desc LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  // user_count = active CRM users (user_type_id=5) currently assigned to
  // this role. Drives the "is it safe to deactivate?" check on the UI.
  // menu_action_count = active permission rows (not soft-deleted) — helps
  // the operator see at-a-glance which roles have action permissions wired.
  const [rows] = await pool.query(
    `SELECT r.role_id, r.role_name, r.role_desc, r.role_status, r.menu_ids,
            (SELECT COUNT(*) FROM tbl_user u
              WHERE u.user_role = r.role_id AND u.user_status = 1 AND u.user_type_id = 5) AS user_count,
            (SELECT COUNT(*) FROM role_menu_action rma
              WHERE rma.role_id = r.role_id AND rma.isDeleted = 0)                        AS menu_action_count
       FROM tbl_role r
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // Decorate with classification group + parsed menu_ids array so the UI
  // can render permission summary columns without a second round-trip.
  const decorated = rows.map((r) => ({
    ...r,
    role_status: r.role_status === 1 || r.role_status === true ? 1 : 0,
    menu_ids: parseMenuIdsCsv(r.menu_ids),
    group: ROLE_ID_TO_GROUP[r.role_id] ?? 'unknown',
  }));

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_role r WHERE ${where.join(' AND ')}`,
    params
  );

  return { items: decorated, total };
}

async function getRoleByIdFull(roleId) {
  const [[row]] = await pool.query(
    `SELECT r.role_id, r.role_name, r.role_desc, r.role_status, r.menu_ids,
            (SELECT COUNT(*) FROM tbl_user u
              WHERE u.user_role = r.role_id AND u.user_status = 1 AND u.user_type_id = 5) AS user_count
       FROM tbl_role r
      WHERE r.role_id = ?
      LIMIT 1`,
    [roleId]
  );
  if (!row) return null;

  // role_menu_action rows currently in effect (NOT soft-deleted). Drives
  // the action-permission checkboxes on the Manage Roles edit form.
  const [actionRows] = await pool.query(
    `SELECT rma.menu_action_id AS id, ma.menu_id, ma.action_name, ma.name
       FROM role_menu_action rma
       LEFT JOIN menu_action ma ON ma.id = rma.menu_action_id
      WHERE rma.role_id = ? AND rma.isDeleted = 0`,
    [roleId]
  );

  return {
    ...row,
    role_status: row.role_status === 1 || row.role_status === true ? 1 : 0,
    menu_ids: parseMenuIdsCsv(row.menu_ids),
    menu_action_ids: actionRows.map((a) => a.id),
    // Keep the joined detail too — the form uses it to preselect by name.
    menu_actions: actionRows.filter((a) => a.id != null),
    group: ROLE_ID_TO_GROUP[row.role_id] ?? 'unknown',
  };
}

/*
 * Effective permissions for a user — what the legacy Java did in
 * LoginAction.java lines 92–98, ported verbatim.
 *
 *   menuIds            = role's CSV menu_ids parsed to int[]. Drives sidebar
 *                        visibility (a menu is visible iff its id is here).
 *   actionPermissions  = list of menu_action.action_name strings derived from
 *                        role_menu_action JOIN menu_action WHERE isDeleted=0.
 *                        Each string is a free-text permission key checked at
 *                        button-render time (e.g. "isUserEdit", "isAddNew").
 *
 * If the user's role is missing, inactive, or has no menu_ids: returns empty
 * arrays. The frontend treats empty-everywhere as "no UI surface" — same as
 * the legacy login (blank sidebar, all-false action map).
 */
async function getEffectivePermissions(userId) {
  if (!userId) return { menuIds: [], actionPermissions: [] };

  const [[user]] = await pool.query(
    'SELECT user_role FROM tbl_user WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (!user || !user.user_role) return { menuIds: [], actionPermissions: [] };

  const role = await getRoleById(user.user_role);
  if (!role || !role.role_status) return { menuIds: [], actionPermissions: [] };

  const [rows] = await pool.query(
    `SELECT ma.action_name
       FROM role_menu_action rma
       JOIN menu_action     ma ON ma.id = rma.menu_action_id
      WHERE rma.role_id = ? AND rma.isDeleted = 0 AND ma.action_name IS NOT NULL`,
    [user.user_role]
  );

  return {
    menuIds: role.menu_ids || [],
    actionPermissions: Array.from(new Set(rows.map((r) => r.action_name).filter(Boolean))),
  };
}

/*
 * Persist the legacy upsert/soft-delete pattern on role_menu_action.
 *
 * The legacy DAO (UserDaoImpl.deleteRoleMenuActionByRoleId + the loop in
 * UserServiceImpl.createAndUpdateRoleMenuAction) does this:
 *
 *   1. UPDATE role_menu_action SET isDeleted=1 WHERE role_id=?
 *   2. For each new menu_action_id:
 *        try: UPDATE role_menu_action SET isDeleted=0
 *               WHERE menu_action_id=? AND role_id=?
 *        if 0 rows affected: INSERT INTO role_menu_action(menu_action_id, isDeleted, role_id)
 *                            VALUES(?, 0, ?)
 *
 * We replicate it 1:1 inside a transaction so failures don't leave the role
 * with a half-applied permission set. The connection comes from the pool;
 * caller passes it in so the parent call (createRole / updateRole) can wrap
 * tbl_role mutations in the same transaction.
 */
async function applyMenuActionIds(conn, roleId, menuActionIds) {
  const ids = Array.from(new Set(
    (menuActionIds || [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0)
  ));

  // Step 1: soft-delete every existing row for this role. Even if the new
  // set is identical, we'd then restore-via-UPDATE in step 2 — net no-op,
  // matches legacy.
  await conn.query(
    'UPDATE role_menu_action SET isDeleted = 1 WHERE role_id = ?',
    [roleId]
  );

  // Step 2: upsert each new id.
  for (const menuActionId of ids) {
    const [r] = await conn.query(
      `UPDATE role_menu_action
          SET isDeleted = 0
        WHERE menu_action_id = ? AND role_id = ?`,
      [menuActionId, roleId]
    );
    if (r.affectedRows === 0) {
      await conn.query(
        `INSERT INTO role_menu_action (menu_action_id, isDeleted, role_id)
         VALUES (?, 0, ?)`,
        [menuActionId, roleId]
      );
    }
  }
}

function toMenuIdsCsv(menuIds) {
  return parseMenuIdsCsv(menuIds).join(',') || null;
}

async function createRole({ role_name, role_desc, menu_ids, menu_action_ids, createdBy }) {
  const name = String(role_name || '').trim();
  if (!name)         throw mkErr(400, 'role_name is required');
  if (name.length > 100) throw mkErr(400, 'role_name is too long (max 100)');

  // Case-insensitive uniqueness on role_name. The legacy DB has near-dupes
  // ("Client Dashboard User" vs "ClientDashboard User") which we tolerate
  // for backward compat — but we don't let new ones be created.
  const [[dup]] = await pool.query(
    'SELECT role_id FROM tbl_role WHERE LOWER(role_name) = LOWER(?) LIMIT 1',
    [name]
  );
  if (dup) throw mkErr(409, `Role "${name}" already exists`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Stamp insert_date / update_date / updated_by — legacy sp_ef_role_add_update_role
    // writes all three. `updated_by` carries the operator's user_id so the audit
    // trail tracks who created the row.
    const [r] = await conn.query(
      `INSERT INTO tbl_role
         (role_name, role_desc, role_status, menu_ids, insert_date, update_date, updated_by)
       VALUES (?, ?, 1, ?, NOW(), NOW(), ?)`,
      [
        name,
        role_desc ? String(role_desc).trim() : null,
        toMenuIdsCsv(menu_ids),
        createdBy || null,
      ]
    );
    if (Array.isArray(menu_action_ids) && menu_action_ids.length) {
      await applyMenuActionIds(conn, r.insertId, menu_action_ids);
    }
    await conn.commit();
    await refreshCache();
    return getRoleByIdFull(r.insertId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function updateRole(roleId, fields, updatedBy) {
  const [[me]] = await pool.query(
    'SELECT role_id, role_name FROM tbl_role WHERE role_id = ? LIMIT 1',
    [roleId]
  );
  if (!me) throw mkErr(404, 'Role not found');

  const sets   = [];
  const params = [];

  if (fields.role_name !== undefined) {
    const name = String(fields.role_name).trim();
    if (!name) throw mkErr(400, 'role_name cannot be blank');
    if (name.length > 100) throw mkErr(400, 'role_name is too long (max 100)');
    const [[dup]] = await pool.query(
      `SELECT role_id FROM tbl_role
        WHERE LOWER(role_name) = LOWER(?) AND role_id <> ?
        LIMIT 1`,
      [name, roleId]
    );
    if (dup) throw mkErr(409, `Another role named "${name}" exists`);
    sets.push('role_name = ?'); params.push(name);
  }
  if (fields.role_desc !== undefined) {
    sets.push('role_desc = ?');
    params.push(fields.role_desc ? String(fields.role_desc).trim() : null);
  }
  if (fields.is_active !== undefined) {
    sets.push('role_status = ?');
    params.push(fields.is_active ? 1 : 0);
  }
  // menu_ids overrides the CSV directly. Passing [] explicitly clears it.
  if (fields.menu_ids !== undefined) {
    sets.push('menu_ids = ?');
    params.push(toMenuIdsCsv(fields.menu_ids));
  }

  const wantsActionUpdate = fields.menu_action_ids !== undefined;
  if (!sets.length && !wantsActionUpdate) throw mkErr(400, 'No mutable fields supplied');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (sets.length) {
      // Always stamp update_date + updated_by on any mutation — matches the
      // legacy sp_ef_role_add_update_role which writes both even when only
      // a single field changed. updatedBy is the operator's user_id from
      // the route handler (req.user.user_id).
      sets.push('update_date = NOW()', 'updated_by = ?');
      params.push(updatedBy || null);
      params.push(roleId);
      await conn.query(`UPDATE tbl_role SET ${sets.join(', ')} WHERE role_id = ?`, params);
    } else if (wantsActionUpdate) {
      // Even when only the action set is changing (not any tbl_role column),
      // stamp the audit fields. Otherwise an operator could rewrite a role's
      // entire permission set with no trace on tbl_role.
      await conn.query(
        'UPDATE tbl_role SET update_date = NOW(), updated_by = ? WHERE role_id = ?',
        [updatedBy || null, roleId]
      );
    }
    if (wantsActionUpdate) {
      await applyMenuActionIds(conn, roleId, fields.menu_action_ids || []);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await refreshCache();
  return getRoleByIdFull(roleId);
}

async function deactivateRole(roleId) {
  // Guard: don't soft-delete a role that's actively assigned. Forcing the
  // operator to reassign first prevents the ghost-role-on-user-row state.
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS active_users
       FROM tbl_user
      WHERE user_role = ? AND user_status = 1 AND user_type_id = 5`,
    [roleId]
  );
  if (row.active_users > 0) {
    throw mkErr(
      409,
      `Cannot deactivate — ${row.active_users} active user(s) still assigned to this role. Reassign them first.`
    );
  }

  const [r] = await pool.query(
    'UPDATE tbl_role SET role_status = 0 WHERE role_id = ?',
    [roleId]
  );
  if (r.affectedRows) await refreshCache();
  return r.affectedRows > 0;
}

module.exports = {
  getRoleById,
  classifyRoleIdSync,
  refreshCache,
  ROLE_ID_TO_GROUP,
  // Manage Roles surface
  listRoles,
  getRoleByIdFull,
  createRole,
  updateRole,
  deactivateRole,
  SORTABLE_COLUMNS,
  // Permission resolution (LoginAction.java parity)
  getEffectivePermissions,
};
