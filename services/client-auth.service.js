const { pool } = require('../db');
const logger = require('../logger');
const { generateOtp, otpExpiryDate } = require('../utils/otp');
const jwt = require('jsonwebtoken');

/*
 * Client SPOC authentication — distinct from internal-user auth.
 * Principal: tbl_client_contacts (the SPOC). OTP channel: contact_email or contact_no.
 * JWT claim `sub` is namespaced as `spoc:<id>` so auth.js can distinguish.
 */

async function findSpoc(identifier) {
  const col = /@/.test(identifier) ? 'contact_email' : 'contact_no';
  const [[row]] = await pool.query(
    `SELECT id, client_id, contact_name, contact_email, contact_no
       FROM tbl_client_contacts WHERE ${col} = ? AND status = 1 LIMIT 1`,
    [identifier]
  );
  return row || null;
}

async function findSpocById(id) {
  const [[row]] = await pool.query(
    `SELECT id, client_id, contact_name, contact_email, contact_no
       FROM tbl_client_contacts WHERE id = ? AND status = 1 LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createLoginOtp(identifier) {
  const spoc = await findSpoc(identifier);
  if (!spoc) return { found: false };
  const otp = generateOtp();
  const now = new Date();
  const expires = otpExpiryDate(now);
  // Retire any still-live prior SPOC Login OTPs for this SPOC first, so a stale
  // OTP from an earlier request can't outrank the one we're about to issue.
  await pool.query(
    `UPDATE otp_details SET is_expired = 1
      WHERE otp_type = 'SPOC Login'
        AND (user_email = ? OR user_mobile_no = ?)
        AND is_expired = 0`,
    [spoc.contact_email, spoc.contact_no]
  );
  await pool.query(
    `INSERT INTO otp_details (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
     VALUES (?, 'SPOC Login', ?, ?, ?, ?, 0, 1)`,
    [otp, spoc.contact_email, spoc.contact_no, now, expires]
  );
  if (process.env.NODE_ENV !== 'production') {
    logger.event('🔑', 'cyan',
      `OTP for ${spoc.contact_email || spoc.contact_no}: ${otp}  (client SPOC id=${spoc.id}, valid 5 min) — dev only`);
  }

  const { deliverOtp } = require('./otp-delivery.service');
  await deliverOtp({
    identifier,
    email: spoc.contact_email,
    mobile: spoc.contact_no,
    name: spoc.contact_name,
    otp,
    contextLabel: 'spoc',
  });

  return { found: true, expiresAt: expires };
}

async function verifyLoginOtp(identifier, otp) {
  const spoc = await findSpoc(identifier);
  if (!spoc) return { ok: false, reason: 'USER_NOT_FOUND' };
  const col = /@/.test(identifier) ? 'user_email' : 'user_mobile_no';
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE ${col} = ? AND otp_type = 'SPOC Login' ORDER BY id DESC LIMIT 1`,
    [identifier]
  );
  if (!row) return { ok: false, reason: 'NO_OTP_ISSUED' };
  if (row.is_expired || new Date(row.valid_up_to).getTime() < Date.now()) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) return { ok: false, reason: 'OTP_MISMATCH' };
  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);

  const token = jwt.sign(
    { sub: `spoc:${spoc.id}`, clientId: spoc.client_id, name: spoc.contact_name, email: spoc.contact_email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || '30d' }
  );
  return { ok: true, token, spoc };
}

module.exports = { findSpoc, findSpocById, createLoginOtp, verifyLoginOtp };
