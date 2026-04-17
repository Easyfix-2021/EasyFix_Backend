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

async function send({ to, subject, text, html, cc, bcc, category }) {
  const originalTo = to;
  const originalCc = cc;
  const originalBcc = bcc;
  if (!to) return { delivered: false, error: 'to is required' };
  if (!subject) return { delivered: false, error: 'subject is required' };
  if (!text && !html) return { delivered: false, error: 'text or html body required' };

  if (disabled()) {
    logger.test(`Email suppressed (NOTIFICATIONS_DISABLE) · to=${to} · subject="${subject}"`);
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
      logger.test(`Email redirected from "${originalTo}" → "${to.join(',')}" (TEST_EMAILS) · cc/bcc dropped`);
    }
  }

  try {
    if (!transporter) transporter = buildTransporter();
    // Annotate the subject in test mode so inbox-side it's clear what was intended.
    const finalSubject = redirected ? `[TEST→${Array.isArray(originalTo) ? originalTo.join(',') : originalTo}] ${subject}` : subject;
    // Deliverability hygiene:
    //  - Named From ("EasyFix <...@easyfix.in>") beats bare address for spam filters.
    //  - Reply-To lets recipients actually reach a human instead of the bot account.
    //  - An HTML body alongside text signals a "real" multipart message, not a
    //    scraper-style plain-text blast — Gmail in particular weights this.
    const fromAddress = process.env.SMTP_USER;
    const fromName    = process.env.SMTP_FROM_NAME || 'EasyFix';
    const replyTo     = process.env.SMTP_REPLY_TO || fromAddress;
    const htmlBody    = html || (text
      ? `<p>${String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</p>`
      : undefined);
    // Extra headers that help transactional mail clear spam filters:
    //  - List-Unsubscribe: required by Gmail/Yahoo for bulk; harmless for transactional.
    //  - List-Unsubscribe-Post: RFC 8058 one-click, further boosts trust.
    //  - X-Entity-Ref-ID: random ref gives each message a unique identity in Gmail
    //    threading, avoiding "this looks like the same spam we saw before" clustering.
    //  - Precedence: bulk → well-known hint that this is auto-generated not phishing.
    const extraHeaders = {
      'X-Entity-Ref-ID': `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      'X-Mailer': 'EasyFix-Backend/1.0',
      ...(category === 'transactional' ? {
        'X-Priority': '3',
        'Auto-Submitted': 'auto-generated',
        'List-Unsubscribe': `<mailto:${replyTo}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      } : {}),
    };

    const info = await transporter.sendMail({
      from: `${fromName} <${fromAddress}>`,
      to: Array.isArray(to) ? to.join(',') : to,
      replyTo,
      subject: finalSubject,
      text,
      html: htmlBody,
      headers: extraHeaders,
      cc: cc ? (Array.isArray(cc) ? cc.join(',') : cc) : undefined,
      bcc: bcc ? (Array.isArray(bcc) ? bcc.join(',') : bcc) : undefined,
    });
    const who = Array.isArray(to) ? to.join(',') : to;
    logger.email(`sent to ${who} · "${finalSubject}"${redirected ? ` · was "${originalTo}"` : ''}`);
    return { delivered: true, messageId: info.messageId, response: info.response, redirected, intendedTo: redirected ? originalTo : undefined };
  } catch (err) {
    logger.error(`Email error · to=${to} · ${err.message}`);
    return { delivered: false, error: err.message };
  }
}

module.exports = { send };
