const { pool } = require('../db');
const logger = require('../logger');
const { resolveLoginOtp, otpExpiryDate } = require('../utils/otp');
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
  // Tech logins are always mobile-based, so resolveLoginOtp will return
  // the last 4 digits of the mobile in QA mode (env QA_DETERMINISTIC_OTP=true).
  // In prod the env var is unset → real random OTP. Same gate as auth-service.
  const otp = resolveLoginOtp(mobile);
  const now = new Date();
  const expires = otpExpiryDate(now);
  // Single-row-per-(email, mobile, otp_type) upsert. We always write BOTH
  // tech.efr_email and mobile so the (email, mobile, otp_type) tuple stays
  // meaningful — if a technician's mobile is later reassigned to a different
  // efr (with different email), this tuple is naturally distinct.
  // Legacy partial rows (only mobile, no email) cannot satisfy the AND query
  // in verify, so they stay safely out of the auth flow.
  const [[existing]] = await pool.query(
    `SELECT id FROM otp_details
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'Mobile App Otp'
      LIMIT 1`,
    [tech.efr_email, mobile]
  );
  if (existing) {
    await pool.query(
      `UPDATE otp_details
          SET otp = ?, generated_on = ?, valid_up_to = ?, is_expired = 0,
              count = count + 1
        WHERE id = ?`,
      [otp, now, expires, existing.id]
    );
  } else {
    await pool.query(
      `INSERT INTO otp_details (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
       VALUES (?, 'Mobile App Otp', ?, ?, ?, ?, 0, 1)`,
      [otp, tech.efr_email, mobile, now, expires]
    );
  }
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
  // Match the same (email, mobile, otp_type) tuple createLoginOtp wrote.
  // Both columns AND-ed → legacy mobile-only rows can't bleed into auth.
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'Mobile App Otp'
      LIMIT 1`,
    [tech.efr_email, mobile]);
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
