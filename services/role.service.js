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

async function loadRoles() {
  const [rows] = await pool.query(
    'SELECT role_id, role_name, role_desc, role_status FROM tbl_role'
  );
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.role_id, {
      role_id: row.role_id,
      role_name: row.role_name,
      role_desc: row.role_desc,
      role_status: row.role_status === 1 || row.role_status === true,
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

module.exports = {
  getRoleById,
  classifyRoleIdSync,
  refreshCache,
  ROLE_ID_TO_GROUP,
};
