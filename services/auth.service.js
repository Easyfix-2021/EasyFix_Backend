const { pool } = require('../db');
const logger = require('../logger');
const { generateOtp, otpExpiryDate } = require('../utils/otp');
const { signUserToken } = require('../utils/jwt');

/*
 * Auth model reality (2026-04-17):
 *   - tbl_user has NO password column. Internal user login is OTP-only.
 *   - Legacy EasyFix_CRM also supports Microsoft Azure AD OAuth; that is not
 *     replicated here yet. /api/auth/login is stubbed 501 and will either be
 *     wired to Azure AD or dropped once the blueprint is updated.
 */

async function findActiveUserByIdentifier(identifier) {
  const isEmail = /@/.test(identifier);
  const column = isEmail ? 'official_email' : 'mobile_no';
  const [[user]] = await pool.query(
    `SELECT user_id, user_code, user_name, official_email, user_role, city_id,
            mobile_no, alternate_no, manage_clients, manage_cities, user_status
       FROM tbl_user
      WHERE ${column} = ? AND user_status = 1
      LIMIT 1`,
    [identifier]
  );
  return user || null;
}

async function findUserById(userId) {
  const [[user]] = await pool.query(
    `SELECT user_id, user_code, user_name, official_email, user_role, city_id,
            mobile_no, alternate_no, manage_clients, manage_cities, user_status
       FROM tbl_user
      WHERE user_id = ? AND user_status = 1
      LIMIT 1`,
    [userId]
  );
  return user || null;
}

async function createLoginOtp(identifier) {
  const user = await findActiveUserByIdentifier(identifier);
  if (!user) {
    return { found: false };
  }

  const otp = generateOtp();
  const now = new Date();
  const expires = otpExpiryDate(now);

  await pool.query(
    `INSERT INTO otp_details
       (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
    [otp, 'Login Otp', user.official_email, user.mobile_no, now, expires]
  );

  // DEV ONLY: log the OTP so developers can test without an SMS/email gateway.
  // Step 11 will deliver via SMSCountry + Gmail; at that point remove this log line
  // and send via the notification services instead.
  if (process.env.NODE_ENV !== 'production') {
    logger.warn({ userId: user.user_id, otp, email: user.official_email }, 'DEV OTP issued (do not log in prod)');
  }

  return { found: true, userId: user.user_id, email: user.official_email, expiresAt: expires };
}

async function verifyLoginOtp(identifier, otp) {
  const user = await findActiveUserByIdentifier(identifier);
  if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };

  const isEmail = /@/.test(identifier);
  const column = isEmail ? 'user_email' : 'user_mobile_no';

  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired
       FROM otp_details
      WHERE ${column} = ? AND otp_type = 'Login Otp'
      ORDER BY id DESC
      LIMIT 1`,
    [identifier]
  );

  if (!row) return { ok: false, reason: 'NO_OTP_ISSUED' };
  if (row.is_expired === true || row.is_expired === 1) return { ok: false, reason: 'OTP_EXPIRED' };
  if (new Date(row.valid_up_to).getTime() < Date.now()) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) return { ok: false, reason: 'OTP_MISMATCH' };

  // Consume the OTP so it can't be reused.
  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);

  const token = signUserToken(user);
  return { ok: true, token, user };
}

module.exports = {
  findActiveUserByIdentifier,
  findUserById,
  createLoginOtp,
  verifyLoginOtp,
};
