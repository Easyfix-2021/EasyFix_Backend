const crypto = require('crypto');

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;

function generateOtp() {
  // 4-digit to match legacy format stored as INT in otp_details.otp
  return 1000 + crypto.randomInt(0, 9000);
}

function otpExpiryDate(fromDate = new Date()) {
  return new Date(fromDate.getTime() + OTP_TTL_MINUTES * 60 * 1000);
}

module.exports = { generateOtp, otpExpiryDate, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS };
