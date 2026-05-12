const { pool } = require('../db');

/*
 * Manage Service Category — master for tbl_service_catg.
 *
 * Legacy parity: status convention is 1=Active, 0=Inactive, 3=Soft-deleted.
 * The list defaults to status=1 only. The "Include inactive" toggle
 * surfaces 0; status=3 rows stay hidden (those are legacy "removed").
 *
 * Uniqueness on (LOWER(service_catg_name)) — app-level only, matches the
 * legacy DAO which doesn't enforce a DB unique constraint.
 *
 * Soft-delete: deactivation flips status to 0 (matches the new-app
 * convention used by Manage Cities). The legacy /addDeleteServiceCatg
 * sets status=3 — both values are filtered out of the active list.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  service_catg_id:     'c.service_catg_id',
  service_catg_name:   'c.service_catg_name',
  service_catg_status: 'c.service_catg_status',
  service_type_count:  'service_type_count',
});

async function listCategories({
  q, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'service_catg_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.service_catg_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, c.service_catg_id ASC`;

  const where  = ['c.service_catg_status <> 3'];
  const params = [];
  if (!includeInactive) where.push('c.service_catg_status = 1');
  if (q) {
    where.push('(c.service_catg_name LIKE ? OR c.service_catg_desc LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const [rows] = await pool.query(
    `SELECT c.service_catg_id, c.service_catg_name, c.service_catg_desc,
            c.service_catg_status,
            (SELECT COUNT(*) FROM tbl_service_type st
              WHERE st.service_catg_id = c.service_catg_id
                AND st.service_type_status = 1)        AS service_type_count
       FROM tbl_service_catg c
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_service_catg c WHERE ${where.join(' AND ')}`,
    params
  );

  return { items: rows, total };
}

async function getCategoryById(id) {
  const [[row]] = await pool.query(
    `SELECT service_catg_id, service_catg_name, service_catg_desc, service_catg_status
       FROM tbl_service_catg
      WHERE service_catg_id = ? AND service_catg_status <> 3
      LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createCategory({ service_catg_name, service_catg_desc }) {
  const name = String(service_catg_name || '').trim();
  if (!name) throw mkErr(400, 'service_catg_name is required');
  if (name.length > 200) throw mkErr(400, 'service_catg_name is too long (max 200)');

  const [[dup]] = await pool.query(
    `SELECT service_catg_id FROM tbl_service_catg
      WHERE LOWER(service_catg_name) = LOWER(?) AND service_catg_status <> 3
      LIMIT 1`,
    [name]
  );
  if (dup) throw mkErr(409, `Service Category "${name}" already exists`);

  const [r] = await pool.query(
    `INSERT INTO tbl_service_catg (service_catg_name, service_catg_desc, service_catg_status)
     VALUES (?, ?, 1)`,
    [name, service_catg_desc ? String(service_catg_desc).trim() : null]
  );
  return getCategoryById(r.insertId);
}

async function updateCategory(id, fields) {
  const [[me]] = await pool.query(
    'SELECT service_catg_id FROM tbl_service_catg WHERE service_catg_id = ? AND service_catg_status <> 3 LIMIT 1',
    [id]
  );
  if (!me) throw mkErr(404, 'Service Category not found');

  const sets = [];
  const params = [];
  if (fields.service_catg_name !== undefined) {
    const name = String(fields.service_catg_name).trim();
    if (!name) throw mkErr(400, 'service_catg_name cannot be blank');
    const [[dup]] = await pool.query(
      `SELECT service_catg_id FROM tbl_service_catg
        WHERE LOWER(service_catg_name) = LOWER(?) AND service_catg_id <> ?
          AND service_catg_status <> 3
        LIMIT 1`,
      [name, id]
    );
    if (dup) throw mkErr(409, `Another Service Category named "${name}" exists`);
    sets.push('service_catg_name = ?'); params.push(name);
  }
  if (fields.service_catg_desc !== undefined) {
    sets.push('service_catg_desc = ?');
    params.push(fields.service_catg_desc ? String(fields.service_catg_desc).trim() : null);
  }
  if (fields.is_active !== undefined) {
    sets.push('service_catg_status = ?');
    params.push(fields.is_active ? 1 : 0);
  }

  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  params.push(id);
  await pool.query(`UPDATE tbl_service_catg SET ${sets.join(', ')} WHERE service_catg_id = ?`, params);
  return getCategoryById(id);
}

async function deactivateCategory(id) {
  // Guard: don't deactivate while active service types reference this category.
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM tbl_service_type
      WHERE service_catg_id = ? AND service_type_status = 1`,
    [id]
  );
  if (row.n > 0) {
    throw mkErr(409,
      `Cannot deactivate — ${row.n} active service type(s) still reference this category. Deactivate or reassign them first.`);
  }

  const [r] = await pool.query(
    'UPDATE tbl_service_catg SET service_catg_status = 0 WHERE service_catg_id = ? AND service_catg_status <> 3',
    [id]
  );
  return r.affectedRows > 0;
}

module.exports = {
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deactivateCategory,
  SORTABLE_COLUMNS,
};
