const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const Joi = require('joi');
const validate = require('../../middleware/validate');

/*
 * Manage Customers — minimal admin surface over tbl_customer + tbl_address.
 *
 * Legacy `customerList.vm` + `addEditCustomers.vm` had heavy multi-tab forms
 * (personal + multiple addresses + history). The new platform mostly auto-
 * upserts customers via job creation, so this admin surface is read-first
 * with a light upsert path.
 *
 * Columns observed in legacy: customer_id, customer_name, customer_mob_no,
 * customer_email, alt_mob_no, customer_status, insert_date, update_date.
 */

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  limit:           Joi.number().integer().min(1).max(500).default(100),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid('customer_id', 'customer_name', 'customer_mob_no').default('customer_id'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('desc'),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { q, limit, offset, sortBy, sortDir } = req.query;
    const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
    const where = ['1=1'];
    const params = [];
    if (q) {
      where.push('(customer_name LIKE ? OR customer_mob_no LIKE ? OR customer_email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await pool.query(
      `SELECT customer_id, customer_name, customer_mob_no, customer_email,
              alt_mob_no, customer_status, insert_date, update_date,
              (SELECT COUNT(*) FROM tbl_job j WHERE j.fk_customer_id = c.customer_id) AS job_count
         FROM tbl_customer c
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortBy} ${dir}
        LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tbl_customer c WHERE ${where.join(' AND ')}`, params);
    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT * FROM tbl_customer WHERE customer_id = ? LIMIT 1`, [req.params.id]);
    if (!row) return modernError(res, 404, 'Customer not found');
    const [addresses] = await pool.query(
      `SELECT * FROM tbl_address WHERE customer_id = ? ORDER BY address_id DESC LIMIT 50`,
      [req.params.id]);
    modernOk(res, { ...row, addresses });
  } catch (e) { next(e); }
});

module.exports = router;
