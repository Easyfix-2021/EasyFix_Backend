const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

// tbl_client_rate_card: crc_id, crc_servicetype_id, crc_ratecard_name, status
// tbl_retail_rate_card: (schema TBD — stub with minimal fields)

router.get('/client', async (req, res, next) => {
  try {
    const { serviceTypeId, q } = req.query;
    const clauses = ['status = 1'], params = [];
    if (serviceTypeId != null) { clauses.push('crc_servicetype_id = ?'); params.push(serviceTypeId); }
    if (q) { clauses.push('crc_ratecard_name LIKE ?'); params.push(`%${q}%`); }
    const [rows] = await pool.query(
      `SELECT crc_id, crc_servicetype_id, crc_ratecard_name, status FROM tbl_client_rate_card WHERE ${clauses.join(' AND ')} ORDER BY crc_ratecard_name LIMIT 500`, params);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/client', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.serviceTypeId) return modernError(res, 400, 'name and serviceTypeId required');
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_rate_card (crc_ratecard_name, crc_servicetype_id, status, insert_date, inserted_by) VALUES (?, ?, 1, NOW(), ?)`,
      [b.name, b.serviceTypeId, req.user.user_id]);
    res.status(201);
    modernOk(res, { crc_id: ins.insertId });
  } catch (e) { next(e); }
});

router.put('/client/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.name) { sets.push('crc_ratecard_name = ?'); vals.push(b.name); }
    if (b.serviceTypeId) { sets.push('crc_servicetype_id = ?'); vals.push(b.serviceTypeId); }
    if (b.status !== undefined) { sets.push('status = ?'); vals.push(b.status ? 1 : 0); }
    if (sets.length === 0) return modernError(res, 400, 'nothing to update');
    sets.push('update_date = NOW()', 'updated_by = ?');
    vals.push(req.user.user_id, req.params.id);
    await pool.query(`UPDATE tbl_client_rate_card SET ${sets.join(', ')} WHERE crc_id = ?`, vals);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.delete('/client/:id', async (req, res, next) => {
  try {
    await pool.query(`UPDATE tbl_client_rate_card SET status = 0, update_date = NOW(), updated_by = ? WHERE crc_id = ?`,
      [req.user.user_id, req.params.id]);
    modernOk(res, { deactivated: true });
  } catch (e) { next(e); }
});

// Retail rate card (read-only stub)
router.get('/retail', async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM tbl_retail_rate_card LIMIT 500").catch(() => [[]]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
