const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { roleByName } = require('../../middleware/role');
const { modernOk, modernError } = require('../../utils/response');

// Admin-only (already gated at /api/admin). Additional user-mgmt restriction:
// only roles 2 ("Admin") and 15 ("Admin Supply") can mutate users.
router.get('/', async (req, res, next) => {
  try {
    const { q, roleId, includeInactive } = req.query;
    const clauses = [], params = [];
    if (includeInactive !== 'true') clauses.push('u.user_status = 1');
    if (roleId != null) { clauses.push('u.user_role = ?'); params.push(roleId); }
    if (q) { clauses.push('(u.user_name LIKE ? OR u.official_email LIKE ? OR u.mobile_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    params.push(limit, offset);
    const [rows] = await pool.query(
      `SELECT u.user_id, u.user_code, u.user_name, u.official_email, u.mobile_no, u.user_role, r.role_name, u.city_id, u.user_status
         FROM tbl_user u LEFT JOIN tbl_role r ON r.role_id = u.user_role
         ${where} ORDER BY u.user_name LIMIT ? OFFSET ?`, params);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [[u]] = await pool.query('SELECT * FROM tbl_user WHERE user_id = ?', [req.params.id]);
    if (!u) return modernError(res, 404, 'user not found');
    modernOk(res, u);
  } catch (e) { next(e); }
});

router.post('/', roleByName(['Admin']), validate(Joi.object({
  userName: Joi.string().max(200).required(),
  officialEmail: Joi.string().email().max(255).required(),
  mobileNo: Joi.string().pattern(/^[0-9]{10}$/).required(),
  userRole: Joi.number().integer().positive().required(),
  cityId: Joi.number().integer().positive().optional(),
})), async (req, res, next) => {
  try {
    const [ins] = await pool.query(
      `INSERT INTO tbl_user (user_name, official_email, mobile_no, user_role, city_id, user_status, insert_date)
       VALUES (?, ?, ?, ?, ?, 1, NOW())`,
      [req.body.userName, req.body.officialEmail, req.body.mobileNo, req.body.userRole, req.body.cityId || null]);
    res.status(201);
    modernOk(res, { user_id: ins.insertId });
  } catch (e) { next(e); }
});

router.put('/:id', roleByName(['Admin']), async (req, res, next) => {
  try {
    const b = req.body || {};
    const allowed = ['user_name', 'official_email', 'mobile_no', 'alternate_no', 'user_role', 'city_id', 'user_status', 'manage_clients', 'manage_cities', 'manage_states'];
    const sets = [], vals = [];
    for (const k of allowed) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
    if (sets.length === 0) return modernError(res, 400, 'nothing to update');
    sets.push('update_date = NOW()', 'updated_by = ?');
    vals.push(req.user.user_id, req.params.id);
    await pool.query(`UPDATE tbl_user SET ${sets.join(', ')} WHERE user_id = ?`, vals);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.patch('/:id/status', roleByName(['Admin']), async (req, res, next) => {
  try {
    await pool.query('UPDATE tbl_user SET user_status = ?, update_date = NOW(), updated_by = ? WHERE user_id = ?',
      [req.body.active ? 1 : 0, req.user.user_id, req.params.id]);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

module.exports = router;
