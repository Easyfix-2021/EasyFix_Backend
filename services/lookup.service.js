const { pool } = require('../db');

/*
 * Read-only lookup queries powering dropdowns across CRM_UI / Client_UI / Mobile.
 *
 * Real table-name reconciliation with blueprint §3 (2026-04-17):
 *   - tbl_reschedule_reason  →  reschedule_reason_app (4 rows)
 *   - tbl_bank               →  bank_name (154 rows)
 *   - tbl_cancel_reason      exists (1 row — thin; may need to merge with
 *                            job_cancel_reason_by_easyfixer_app in future)
 *
 * All queries are parameterised. Status/active filtering defaults to ON;
 * pass includeInactive=true for admin tooling that needs the full list.
 */

// ─── Cities / States ─────────────────────────────────────────────────
async function cities({ stateId, q, limit = 500, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('city_status = 1');
  if (stateId != null)  { clauses.push('state_id = ?'); params.push(stateId); }
  if (q)                { clauses.push('city_name LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit));
  const [rows] = await pool.query(
    `SELECT city_id, city_name, state_id, city_status, tier, district, reference_pincode
       FROM tbl_city ${where}
       ORDER BY city_name ASC LIMIT ?`,
    params
  );
  return rows;
}

async function states() {
  const [rows] = await pool.query(
    `SELECT state_id, state_code, state_name, country_id
       FROM tbl_state ORDER BY state_name ASC`
  );
  return rows;
}

// ─── Services ───────────────────────────────────────────────────────
async function serviceCategories({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE service_catg_status = 1';
  const [rows] = await pool.query(
    `SELECT service_catg_id, service_catg_name, service_catg_desc, service_catg_status
       FROM tbl_service_catg ${where}
       ORDER BY service_catg_name ASC`
  );
  return rows;
}

async function serviceTypes({ categoryId, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('service_type_status = 1');
  if (categoryId != null) { clauses.push('service_catg_id = ?'); params.push(categoryId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT service_type_id, service_type_name, service_type_desc,
            service_type_status, service_catg_id
       FROM tbl_service_type ${where}
       ORDER BY service_type_name ASC`,
    params
  );
  return rows;
}

// ─── Clients ────────────────────────────────────────────────────────
async function clients({ q, limit = 100, offset = 0, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('client_status = 1');
  if (q)                { clauses.push('client_name LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit), Number(offset));
  const [rows] = await pool.query(
    `SELECT client_id, client_name, client_email, client_status,
            client_city_id, client_type, reference_code
       FROM tbl_client ${where}
       ORDER BY client_name ASC LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

async function clientServices({ clientId, includeInactive = false }) {
  if (clientId == null) throw Object.assign(new Error('clientId is required'), { status: 400 });
  const clauses = ['cs.client_id = ?'];
  const params = [clientId];
  if (!includeInactive) clauses.push('cs.service_status = 1');
  const [rows] = await pool.query(
    `SELECT cs.client_service_id, cs.client_id, cs.service_type_id, cs.service_catg_id,
            cs.rate_card_id, cs.charge_type, cs.total_amount, cs.service_status,
            st.service_type_name, sc.service_catg_name, rc.crc_ratecard_name
       FROM tbl_client_service cs
       LEFT JOIN tbl_service_type   st ON st.service_type_id = cs.service_type_id
       LEFT JOIN tbl_service_catg   sc ON sc.service_catg_id = cs.service_catg_id
       LEFT JOIN tbl_client_rate_card rc ON rc.crc_id        = cs.rate_card_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY st.service_type_name ASC
      LIMIT 1000`,
    params
  );
  return rows;
}

// ─── Users (admin-scoped) ───────────────────────────────────────────
async function users({ q, roleGroup, limit = 100, offset = 0, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('u.user_status = 1');
  if (q) {
    clauses.push('(u.user_name LIKE ? OR u.official_email LIKE ? OR u.mobile_no LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (roleGroup) {
    const { ROLE_ID_TO_GROUP } = require('./role.service');
    const ids = Object.entries(ROLE_ID_TO_GROUP).filter(([, g]) => g === roleGroup).map(([id]) => Number(id));
    if (ids.length === 0) return [];
    clauses.push(`u.user_role IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit), Number(offset));
  const [rows] = await pool.query(
    `SELECT u.user_id, u.user_code, u.user_name, u.official_email,
            u.mobile_no, u.user_role, r.role_name, u.city_id, u.user_status
       FROM tbl_user u
       LEFT JOIN tbl_role r ON r.role_id = u.user_role
      ${where}
      ORDER BY u.user_name ASC LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

// ─── Sidebar menus (tbl_menu) ───────────────────────────────────────
/*
 * Returns the active menu tree as a flat list sorted by sequence. Frontend
 * rebuilds the nest from parent_menu FKs. `url='javascript:;'` rows are
 * parent-only nodes (children provide the actual navigation). We don't encode
 * per-role visibility at the DB level — consumer applies a hardcoded allowlist
 * after fetching (see Sidebar.tsx) so role changes don't need a SQL migration.
 */
async function menus() {
  // `menu_status` is also returned (even though we filter on it) so the
  // frontend can re-assert the active-only contract defensively — protects
  // the sidebar if a future caller forgets the WHERE clause.
  const [rows] = await pool.query(
    `SELECT menu_id, menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status
       FROM tbl_menu
      WHERE menu_status = 1
      ORDER BY COALESCE(sequence, 999) ASC, menu_id ASC`
  );
  return rows;
}

// ─── Easyfixers (technician picker) ─────────────────────────────────
/*
 * Compact projection — just what a picker dropdown needs. Full list is ~4,254
 * active rows; at ~60 bytes per row that's <300 KB, well within a cacheable
 * single lookup response. Search by name / mobile / email for typeahead.
 */
async function easyfixers({ q, limit = 5000, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('e.efr_status = 1');
  if (q) {
    clauses.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_email LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit));
  const [rows] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email,
            e.efr_cityId, c.city_name,
            e.is_technician_verified, e.efr_status
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      ${where}
      ORDER BY e.efr_name ASC
      LIMIT ?`,
    params
  );
  return rows;
}

// ─── Small lookups ──────────────────────────────────────────────────
async function cancelReasons() {
  const [rows] = await pool.query(
    `SELECT cancel_id AS id, cancel_reason AS reason, status
       FROM tbl_cancel_reason WHERE status = 1
       ORDER BY cancel_reason ASC`
  );
  return rows;
}

async function rescheduleReasons() {
  // Actual table is reschedule_reason_app (blueprint's tbl_reschedule_reason doesn't exist).
  const [rows] = await pool.query(
    `SELECT id, reschedule_reason AS reason FROM reschedule_reason_app ORDER BY id ASC`
  );
  return rows;
}

async function banks({ q } = {}) {
  // Actual table is bank_name (blueprint's tbl_bank doesn't exist).
  const clauses = [];
  const params = [];
  if (q) { clauses.push('bank_name LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT id, bank_name, is_easyfix_bank FROM bank_name ${where} ORDER BY bank_name ASC`,
    params
  );
  return rows;
}

async function documentTypes({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE document_type_status = 1';
  const [rows] = await pool.query(
    `SELECT document_type_id, document_name, document_mandatory,
            document_type_status, document_catg_id
       FROM tbl_document_type ${where}
       ORDER BY document_name ASC`
  );
  return rows;
}

module.exports = {
  cities,
  states,
  serviceCategories,
  serviceTypes,
  clients,
  clientServices,
  users,
  easyfixers,
  menus,
  cancelReasons,
  rescheduleReasons,
  banks,
  documentTypes,
};
