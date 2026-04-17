const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tbl_questionaire ORDER BY id DESC LIMIT 500');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/:id/details', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tbl_questionaire_details WHERE questionaire_id = ?', [req.params.id]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name) return modernError(res, 400, 'name required');
    const [ins] = await pool.query(
      'INSERT INTO tbl_questionaire (q_name, status, created_date) VALUES (?, 1, NOW())',
      [b.name]).catch(async () => {
        // fallback column names
        const [r] = await pool.query('INSERT INTO tbl_questionaire (name, status) VALUES (?, 1)', [b.name]);
        return [r];
      });
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

router.get('/answers/:jobId', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tbl_questionaire_answer WHERE job_id = ?', [req.params.jobId]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
