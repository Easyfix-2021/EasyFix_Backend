const logger = require('../logger');

/*
 * SMS delivery via SMSCountry.
 * Legacy contract replicated from ACD_APIs/.../SmsSender.java:
 *   POST http://smscountry.com/SMSCwebservice_Bulk.aspx
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: User=...&passwd=...&mobilenumber=...&message=...&sid=...&mtype=N&DR=N
 *
 * Dev guard: NOTIFICATIONS_DISABLE=true short-circuits to a logged-only
 * "disabled" response — nothing hits the provider. Critical when developing
 * against the QA database, where mobile numbers belong to real customers.
 */

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

function normaliseMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  // Accept 10-digit (India) or 12-digit (91-prefixed). Downstream accepts either.
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return null;
}

async function send({ to, message }) {
  const originalMobile = normaliseMobile(to);
  if (!originalMobile) return { delivered: false, error: `invalid mobile "${to}"` };
  if (!message) return { delivered: false, error: 'message is empty' };

  if (disabled()) {
    logger.info({ channel: 'sms', to: originalMobile, len: message.length }, 'notification DISABLED');
    return { delivered: false, disabled: true };
  }

  const username   = process.env.SMS_USERNAME;
  const password   = process.env.SMS_PASSWORD;
  const senderId   = process.env.SMS_SENDER_ID || 'EsyFix';
  if (!username || !password) {
    return { delivered: false, error: 'SMS_USERNAME/SMS_PASSWORD not configured' };
  }

  // ── TEST-MODE INTERCEPTION (last point before provider call) ──
  let mobile = originalMobile;
  let redirected = false;
  if (process.env.TEST_MOBILE) {
    const test = normaliseMobile(process.env.TEST_MOBILE);
    if (test) { mobile = test; redirected = true; }
  }
  if (redirected) {
    logger.warn({ channel: 'sms', intendedTo: originalMobile, redirectedTo: mobile },
      'TEST_MODE: SMS redirected');
  }

  const body = new URLSearchParams({
    User: username,
    passwd: password,
    mobilenumber: mobile,
    message,
    sid: senderId,
    mtype: 'N',
    DR: 'N',
  }).toString();

  try {
    const res = await fetch('http://smscountry.com/SMSCwebservice_Bulk.aspx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    const delivered = res.ok && !/error|fail/i.test(text);
    logger.info({ channel: 'sms', to: mobile, status: res.status, response: text.slice(0, 100), redirected, intendedTo: redirected ? originalMobile : undefined }, 'sms sent');
    return { delivered, providerResponse: text, httpStatus: res.status, redirected, intendedTo: redirected ? originalMobile : undefined };
  } catch (err) {
    logger.warn({ channel: 'sms', to: mobile, err: err.message }, 'sms error');
    return { delivered: false, error: err.message };
  }
}

module.exports = { send, normaliseMobile };
