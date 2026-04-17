const logger = require('../logger');

/*
 * WhatsApp delivery via Gallabox template API.
 * Legacy contract replicated from ACD_APIs/.../WhatsNotificationUtil.java:
 *   POST https://server.gallabox.com/devapi/messages/whatsapp
 *   Headers:
 *     apiKey: <GALLABOX_API_KEY>
 *     apiSecret: <GALLABOX_API_SECRET>
 *     Content-Type: application/json
 *   Body:
 *   {
 *     "channelId": "<GALLABOX_CHANNEL_ID>",
 *     "channelType": "whatsapp",
 *     "recipient": { "name": "...", "phone": "91XXXXXXXXXX" },
 *     "whatsapp": {
 *       "type": "template",
 *       "template": {
 *         "templateName": "...",          // pre-approved Gallabox template
 *         "bodyValues":   { ... },
 *         "headerValues": { ... },         // optional
 *         "buttonValues": [ ... ]          // optional
 *       }
 *     }
 *   }
 *
 * Phone numbers are always "91" + 10-digit mobile (India). Templates must
 * be pre-approved in Gallabox — new ones can't be sent freeform.
 */

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

function normaliseIndianPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

async function sendTemplate({
  to, recipientName,
  templateName, bodyValues = {}, headerValues, buttonValues,
}) {
  const originalPhone = normaliseIndianPhone(to);
  if (!originalPhone) return { delivered: false, error: `invalid phone "${to}"` };
  if (!templateName) return { delivered: false, error: 'templateName required' };

  if (disabled()) {
    logger.test(`WhatsApp suppressed (NOTIFICATIONS_DISABLE) · to=${originalPhone} · template=${templateName}`);
    return { delivered: false, disabled: true };
  }

  const apiKey    = process.env.GALLABOX_API_KEY;
  const apiSecret = process.env.GALLABOX_API_SECRET;
  const channelId = process.env.GALLABOX_CHANNEL_ID;
  const url       = process.env.GALLABOX_URL || 'https://server.gallabox.com/devapi/messages/whatsapp';
  if (!apiKey || !apiSecret || !channelId) {
    return { delivered: false, error: 'GALLABOX_API_KEY / API_SECRET / CHANNEL_ID not configured' };
  }

  // ── TEST-MODE INTERCEPTION (last point before Gallabox call) ──
  let phone = originalPhone;
  let redirected = false;
  if (process.env.TEST_MOBILE) {
    const test = normaliseIndianPhone(process.env.TEST_MOBILE);
    if (test) { phone = test; redirected = true; }
  }
  if (redirected) {
    logger.test(`WhatsApp redirected from ${originalPhone} → ${phone} (TEST_MOBILE) · template=${templateName}`);
  }

  const template = { templateName, bodyValues };
  if (headerValues) template.headerValues = headerValues;
  if (buttonValues) template.buttonValues = buttonValues;

  const body = {
    channelId,
    channelType: 'whatsapp',
    recipient: { name: recipientName || '', phone },
    whatsapp: { type: 'template', template },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { apiKey, apiSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const delivered = res.ok;
    const who = redirected ? `${phone} (was ${originalPhone})` : phone;
    if (delivered) logger.whatsapp(`sent to ${who} · template=${templateName}`);
    else           logger.warn(`WhatsApp rejected · to=${who} · template=${templateName} · status=${res.status} · ${text.slice(0, 120)}`);
    return { delivered, providerResponse: text, httpStatus: res.status, redirected, intendedTo: redirected ? originalPhone : undefined };
  } catch (err) {
    logger.error(`WhatsApp error · to=${phone} · template=${templateName} · ${err.message}`);
    return { delivered: false, error: err.message };
  }
}

module.exports = { sendTemplate, normaliseIndianPhone };
