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

  // Retire any still-live prior OTPs for this user BEFORE issuing the new one.
  // Without this, a user who re-requested OTP would have multiple valid rows in
  // otp_details; verify picks the latest by id DESC, so entering the OTP from an
  // older SMS silently fails with OTP_MISMATCH — confusing and hard to diagnose.
  await pool.query(
    `UPDATE otp_details SET is_expired = 1
      WHERE otp_type = 'Login Otp'
        AND (user_email = ? OR user_mobile_no = ?)
        AND is_expired = 0`,
    [user.official_email, user.mobile_no]
  );

  // Persist the OTP FIRST, then send. If the INSERT throws, we bail before
  // any SMS/email goes out — otherwise the user would get a code that isn't
  // in the DB and verify would always fail, looking like a server bug. Only
  // after the row is written do we hand off to deliverOtp below.
  const [insertResult] = await pool.query(
    `INSERT INTO otp_details
       (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
    [otp, 'Login Otp', user.official_email, user.mobile_no, now, expires]
  );
  if (!insertResult?.insertId) {
    // Should be impossible given MySQL's AUTO_INCREMENT on otp_details.id, but
    // fail closed rather than send a code the user can't verify.
    throw new Error('Failed to persist OTP row before dispatch');
  }

  // DEV ONLY: log the OTP so developers can test without an SMS/email gateway.
  // Step 11 will deliver via SMSCountry + Gmail; at that point remove this log line
  // and send via the notification services instead.
  if (process.env.NODE_ENV !== 'production') {
    logger.event('🔑', 'cyan',
      `OTP for ${user.official_email || user.mobile_no}: ${otp}  (staff user_id=${user.user_id}, valid 5 min) — dev only`);
  }

  // Channel-preference delivery:
  //   email identifier → Email first, WhatsApp fallback
  //   mobile identifier → WhatsApp first, SMS fallback
  // TEST_EMAILS / TEST_MOBILE redirections inside each provider service keep
  // dev traffic from reaching real users.
  const { deliverOtp } = require('./otp-delivery.service');
  await deliverOtp({
    identifier,
    email: user.official_email,
    mobile: user.mobile_no,
    name: user.user_name,
    otp,
    contextLabel: 'staff',
  });

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
