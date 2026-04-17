const mysql = require('mysql2/promise');
const logger = require('./logger');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  database: process.env.DB_NAME || 'easyfix_core',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '20', 10),
  connectTimeout: parseInt(process.env.DB_CONNECT_TIMEOUT || '30000', 10),
  enableKeepAlive: true,
  waitForConnections: true,
  dateStrings: true,
  timezone: '+05:30',
  typeCast(field, next) {
    // Coerce TINYINT(1) → boolean
    if (field.type === 'TINY' && field.length === 1) {
      const v = field.string();
      return v === null ? null : v === '1';
    }
    // Coerce BIT(1) → boolean (otherwise returned as Buffer, e.g. <Buffer 01>).
    // otp_details.is_expired, tbl_user.is_*, and many other flags use BIT(1).
    if (field.type === 'BIT' && field.length === 1) {
      const buf = field.buffer();
      if (buf === null) return null;
      return buf[0] === 1;
    }
    return next();
  },
});

async function testConnection() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT 1 AS ok, DATABASE() AS db, NOW() AS ts');
    logger.info({ db: rows[0].db, ts: rows[0].ts }, 'database connected');
    return true;
  } finally {
    conn.release();
  }
}

async function closePool() {
  await pool.end();
  logger.info('database pool closed');
}

module.exports = { pool, testConnection, closePool };
