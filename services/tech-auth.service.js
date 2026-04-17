const { pool } = require('../db');
const logger = require('../logger');
const { generateOtp, otpExpiryDate } = require('../utils/otp');
const jwt = require('jsonwebtoken');

/*
 * Technician authentication — against tbl_easyfixer.
 * OTP delivered via efr_no (mobile). JWT `sub` = `efr:<id>`.
 */

async function findByMobile(mobile) {
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_name, efr_no, efr_email FROM tbl_easyfixer
      WHERE efr_no = ? AND efr_status = 1 LIMIT 1`,
    [mobile]);
  return row || null;
}

async function findById(id) {
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_name, efr_no, efr_email, efr_cityId, efr_service_category
       FROM tbl_easyfixer WHERE efr_id = ? AND efr_status = 1 LIMIT 1`, [id]);
  return row || null;
}

async function createLoginOtp(mobile) {
  const tech = await findByMobile(mobile);
  if (!tech) return { found: false };
  const otp = generateOtp();
  const now = new Date();
  const expires = otpExpiryDate(now);
  // Retire any still-live prior Tech Login OTPs for this mobile first, so the
  // user can't accidentally type an older one (verify picks the newest).
  await pool.query(
    `UPDATE otp_details SET is_expired = 1
      WHERE otp_type = 'Tech Login' AND user_mobile_no = ? AND is_expired = 0`,
    [mobile]);
  await pool.query(
    `INSERT INTO otp_details (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
     VALUES (?, 'Tech Login', ?, ?, ?, ?, 0, 1)`,
    [otp, tech.efr_email, mobile, now, expires]);
  if (process.env.NODE_ENV !== 'production') {
    logger.event('🔑', 'cyan',
      `OTP for ${mobile}: ${otp}  (technician efr_id=${tech.efr_id}, valid 5 min) — dev only`);
  }

  // Technicians always log in with a mobile number, so the default branch
  // (WhatsApp first, SMS fallback) applies — email is only used if they have
  // one on file and prefer email templates (rare).
  const { deliverOtp } = require('./otp-delivery.service');
  await deliverOtp({
    identifier: mobile,
    email: tech.efr_email,
    mobile,
    name: tech.efr_name,
    otp,
    contextLabel: 'technician',
  });

  return { found: true, expiresAt: expires };
}

async function verifyLoginOtp(mobile, otp) {
  const tech = await findByMobile(mobile);
  if (!tech) return { ok: false, reason: 'USER_NOT_FOUND' };
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE user_mobile_no = ? AND otp_type = 'Tech Login' ORDER BY id DESC LIMIT 1`, [mobile]);
  if (!row) return { ok: false, reason: 'NO_OTP_ISSUED' };
  if (row.is_expired || new Date(row.valid_up_to).getTime() < Date.now()) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) return { ok: false, reason: 'OTP_MISMATCH' };
  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
  const token = jwt.sign(
    { sub: `efr:${tech.efr_id}`, name: tech.efr_name, mobile: tech.efr_no },
    process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '30d' });
  return { ok: true, token, tech };
}

module.exports = { findByMobile, findById, createLoginOtp, verifyLoginOtp };
