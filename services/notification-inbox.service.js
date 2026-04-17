const { pool } = require('../db');

/*
 * In-app notification inbox — dashboard_notification_log (user_id-scoped).
 * Distinct from the outbound SMS/email/WhatsApp/FCM services in Phase 1A;
 * this is the UI inbox that shows "you have 3 new notifications".
 */

async function create({ userId, jobId, title, desc, notifyTo }) {
  const [r] = await pool.query(
    `INSERT INTO dashboard_notification_log (user_id, job_id, n_title, n_desc, n_to, status, createdAt)
     VALUES (?, ?, ?, ?, ?, 'unread', NOW())`,
    [userId, jobId || null, title, desc || null, notifyTo || null]);
  return r.insertId;
}

async function listByUser(userId, { limit = 50, offset = 0 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, user_id, job_id, n_title, n_desc, n_to, status, createdAt
       FROM dashboard_notification_log WHERE user_id = ?
       ORDER BY id DESC LIMIT ? OFFSET ?`,
    [userId, Number(limit), Number(offset)]);
  return rows;
}

async function countUnread(userId) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM dashboard_notification_log WHERE user_id = ? AND status = 'unread'`,
    [userId]);
  return r.n;
}

async function listByJob(jobId) {
  const [rows] = await pool.query(
    'SELECT * FROM dashboard_notification_log WHERE job_id = ? ORDER BY id DESC', [jobId]);
  return rows;
}

async function markRead(id) {
  await pool.query(`UPDATE dashboard_notification_log SET status = 'read', updateAt = NOW() WHERE id = ?`, [id]);
}

async function markAllRead(userId) {
  await pool.query(
    `UPDATE dashboard_notification_log SET status = 'read', updateAt = NOW() WHERE user_id = ? AND status = 'unread'`,
    [userId]);
}

async function templates() {
  const [rows] = await pool.query(
    `SELECT id, job_stage, notification_title, notification_content FROM dashboard_notification_templates WHERE status = 1`);
  return rows;
}

module.exports = { create, listByUser, countUnread, listByJob, markRead, markAllRead, templates };
