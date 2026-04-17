const nodemailer = require('nodemailer');
const logger = require('../logger');

/*
 * Email via Gmail SMTP using the shared account (SMTP_USER / SMTP_PASSWORD).
 * Uses STARTTLS on port 587.
 *
 * The transporter is instantiated lazily so the module loads in dev even
 * without SMTP creds. First send() reads env.
 */

let transporter = null;

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

function buildTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) throw new Error('SMTP_USER / SMTP_PASSWORD not configured');
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    auth: { user, pass },
  });
}

async function send({ to, subject, text, html, cc, bcc }) {
  const originalTo = to;
  const originalCc = cc;
  const originalBcc = bcc;
  if (!to) return { delivered: false, error: 'to is required' };
  if (!subject) return { delivered: false, error: 'subject is required' };
  if (!text && !html) return { delivered: false, error: 'text or html body required' };

  if (disabled()) {
    logger.info({ channel: 'email', to, subject }, 'notification DISABLED');
    return { delivered: false, disabled: true };
  }

  // ── TEST-MODE INTERCEPTION (last point before SMTP send) ──
  let redirected = false;
  if (process.env.TEST_EMAILS) {
    const testList = process.env.TEST_EMAILS.split(',').map((s) => s.trim()).filter(Boolean);
    if (testList.length) {
      to = testList;
      cc = undefined;   // drop cc entirely — test mode doesn't replicate cc recipients
      bcc = undefined;
      redirected = true;
      logger.warn({ channel: 'email', intendedTo: originalTo, intendedCc: originalCc, intendedBcc: originalBcc, redirectedTo: to },
        'TEST_MODE: email redirected');
    }
  }

  try {
    if (!transporter) transporter = buildTransporter();
    // Annotate the subject in test mode so inbox-side it's clear what was intended.
    const finalSubject = redirected ? `[TEST→${Array.isArray(originalTo) ? originalTo.join(',') : originalTo}] ${subject}` : subject;
    const info = await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: Array.isArray(to) ? to.join(',') : to,
      subject: finalSubject,
      text,
      html,
      cc: cc ? (Array.isArray(cc) ? cc.join(',') : cc) : undefined,
      bcc: bcc ? (Array.isArray(bcc) ? bcc.join(',') : bcc) : undefined,
    });
    logger.info({ channel: 'email', to, subject: finalSubject, messageId: info.messageId, redirected }, 'email sent');
    return { delivered: true, messageId: info.messageId, response: info.response, redirected, intendedTo: redirected ? originalTo : undefined };
  } catch (err) {
    logger.warn({ channel: 'email', to, err: err.message }, 'email error');
    return { delivered: false, error: err.message };
  }
}

module.exports = { send };
