const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

/*
 * Admin CRUD for master/lookup tables.
 * Read endpoints also exist in /api/shared/lookup/* — this tree provides
 * mutating endpoints (create/update/deactivate) admin-only.
 */

function crudFactory(table, pk, nameCol, statusCol, allowedCols) {
  const r = require('express').Router();

  r.get('/', async (req, res, next) => {
    try {
      const { includeInactive, q } = req.query;
      const clauses = [], params = [];
      if (includeInactive !== 'true' && statusCol) clauses.push(`${statusCol} = 1`);
      if (q && nameCol) { clauses.push(`${nameCol} LIKE ?`); params.push(`%${q}%`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      params.push(limit);
      const [rows] = await pool.query(`SELECT * FROM ${table} ${where} ORDER BY ${pk} DESC LIMIT ?`, params);
      modernOk(res, rows);
    } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const [[row]] = await pool.query(`SELECT * FROM ${table} WHERE ${pk} = ?`, [req.params.id]);
      if (!row) return modernError(res, 404, 'not found');
      modernOk(res, row);
    } catch (e) { next(e); }
  });

  r.post('/', async (req, res, next) => {
    try {
      const b = req.body || {};
      const cols = [], vals = [];
      for (const c of allowedCols) if (b[c] !== undefined) { cols.push(c); vals.push(b[c]); }
      if (cols.length === 0) return modernError(res, 400, 'body required');
      if (statusCol && b[statusCol] === undefined) { cols.push(statusCol); vals.push(1); }
      const [ins] = await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
      res.status(201);
      modernOk(res, { id: ins.insertId });
    } catch (e) { next(e); }
  });

  r.put('/:id', async (req, res, next) => {
    try {
      const b = req.body || {};
      const sets = [], vals = [];
      for (const c of allowedCols) if (b[c] !== undefined) { sets.push(`${c} = ?`); vals.push(b[c]); }
      if (sets.length === 0) return modernError(res, 400, 'nothing to update');
      vals.push(req.params.id);
      await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${pk} = ?`, vals);
      modernOk(res, { updated: true });
    } catch (e) { next(e); }
  });

  if (statusCol) {
    r.delete('/:id', async (req, res, next) => {
      try {
        await pool.query(`UPDATE ${table} SET ${statusCol} = 0 WHERE ${pk} = ?`, [req.params.id]);
        modernOk(res, { deactivated: true });
      } catch (e) { next(e); }
    });
  }
  return r;
}

router.use('/cities',              crudFactory('tbl_city',          'city_id',         'city_name',         'city_status',         ['city_name', 'state_id', 'city_status', 'tier', 'district', 'reference_pincode', 'tat_days']));
router.use('/states',              crudFactory('tbl_state',         'state_id',        'state_name',         null,                  ['state_name', 'state_code', 'country_id']));
router.use('/service-categories',  crudFactory('tbl_service_catg',  'service_catg_id', 'service_catg_name', 'service_catg_status', ['service_catg_name', 'service_catg_desc', 'service_catg_status']));
router.use('/service-types',       crudFactory('tbl_service_type',  'service_type_id', 'service_type_name', 'service_type_status', ['service_type_name', 'service_type_desc', 'service_type_status', 'service_catg_id']));
router.use('/document-types',      crudFactory('tbl_document_type', 'document_type_id','document_name',     'document_type_status',['document_name', 'document_mandatory', 'document_type_status', 'document_catg_id']));
router.use('/cancel-reasons',      crudFactory('tbl_cancel_reason', 'cancel_id',       'cancel_reason',     'status',              ['cancel_reason', 'status']));
router.use('/banks',               crudFactory('bank_name',         'id',              'bank_name',         null,                  ['bank_name', 'is_easyfix_bank']));

module.exports = router;
