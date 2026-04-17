const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

router.get('/completed-jobs', async (req, res, next) => {
  try {
    const { from, to, clientId } = req.query;
    if (!from || !to) return modernError(res, 400, 'from and to required');
    const clauses = ['j.job_status IN (3,5)', 'j.checkout_date_time BETWEEN ? AND ?'];
    const params = [from, to];
    if (clientId != null) { clauses.push('j.fk_client_id = ?'); params.push(clientId); }
    const [rows] = await pool.query(
      `SELECT j.job_id, j.fk_client_id, cl.client_name, j.job_type, j.checkout_date_time,
              ef.efr_name AS easyfixer, ci.city_name, j.total_amount
         FROM tbl_job j
         LEFT JOIN tbl_client    cl ON cl.client_id = j.fk_client_id
         LEFT JOIN tbl_easyfixer ef ON ef.efr_id    = j.fk_easyfixter_id
         LEFT JOIN tbl_address   ad ON ad.address_id = j.fk_address_id
         LEFT JOIN tbl_city      ci ON ci.city_id = ad.city_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY j.checkout_date_time DESC LIMIT 1000`, params);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/easyfixer', async (req, res, next) => {
  try {
    const { from, to, efrId } = req.query;
    const clauses = [], params = [];
    if (efrId != null) { clauses.push('j.fk_easyfixter_id = ?'); params.push(efrId); }
    if (from && to)    { clauses.push('j.checkout_date_time BETWEEN ? AND ?'); params.push(from, to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ef.efr_id, ef.efr_name,
              SUM(CASE WHEN j.job_status IN (3,5) THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN j.job_status = 6 THEN 1 ELSE 0 END) AS cancelled,
              COUNT(j.job_id) AS total_jobs
         FROM tbl_easyfixer ef LEFT JOIN tbl_job j ON j.fk_easyfixter_id = ef.efr_id
         ${where} GROUP BY ef.efr_id, ef.efr_name ORDER BY completed DESC LIMIT 500`, params);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/payout-sheet', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return modernError(res, 400, 'from and to required');
    const [rows] = await pool.query(
      `SELECT ef.efr_id, ef.efr_name, ef.efr_no, ef.current_balance,
              COUNT(j.job_id) AS jobs_completed
         FROM tbl_easyfixer ef
         LEFT JOIN tbl_job j ON j.fk_easyfixter_id = ef.efr_id
           AND j.job_status IN (3,5) AND j.checkout_date_time BETWEEN ? AND ?
        WHERE ef.efr_status = 1
        GROUP BY ef.efr_id ORDER BY jobs_completed DESC LIMIT 1000`, [from, to]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/city-analysis', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ci.city_id, ci.city_name,
              COUNT(j.job_id) AS total_jobs,
              SUM(CASE WHEN j.job_status IN (3,5) THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN j.job_status = 6 THEN 1 ELSE 0 END) AS cancelled
         FROM tbl_city ci
         LEFT JOIN tbl_address ad ON ad.city_id = ci.city_id
         LEFT JOIN tbl_job j ON j.fk_address_id = ad.address_id
        WHERE ci.city_status = 1
        GROUP BY ci.city_id ORDER BY total_jobs DESC LIMIT 100`);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/job-tracking', async (req, res, next) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return modernError(res, 400, 'jobId required');
    const [history] = await pool.query(
      `SELECT sh.id, sh.easyfixer_id, ef.efr_name, sh.schedule_time, sh.reason_id, sh.reschedule_reason
         FROM scheduling_history sh LEFT JOIN tbl_easyfixer ef ON ef.efr_id = sh.easyfixer_id
        WHERE sh.job_id = ? ORDER BY sh.id ASC`, [jobId]);
    modernOk(res, history);
  } catch (e) { next(e); }
});

router.get('/user-hours', async (req, res, next) => {
  try {
    const { from, to, userId } = req.query;
    const [rows] = await pool.query(
      `SELECT user_id, DATE(created_date_time) AS date, COUNT(*) AS actions
         FROM tbl_user_login_logout_logs
         WHERE created_date_time BETWEEN ? AND ?
           ${userId != null ? 'AND user_id = ?' : ''}
         GROUP BY user_id, DATE(created_date_time) ORDER BY date DESC LIMIT 500`,
      userId != null ? [from || '2020-01-01', to || new Date(), userId] : [from || '2020-01-01', to || new Date()]).catch(() => [[]]);
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
