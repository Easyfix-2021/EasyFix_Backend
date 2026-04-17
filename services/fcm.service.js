const logger = require('../logger');

/*
 * Push notifications via Firebase Cloud Messaging (legacy HTTP API).
 * Legacy contract replicated from ACD_APIs/.../SendAppNotification.java:
 *   POST https://fcm.googleapis.com/fcm/send
 *   Headers:
 *     Authorization: Key=<FCM_API_KEY>   (yes — literal word "Key=")
 *     Content-Type: application/json
 *   Body:
 *   {
 *     "to": "<FCM registration token>",
 *     "notification": { "title": "...", "body": "..." },
 *     "data":         { ...arbitrary k/v... }
 *   }
 *
 * IMPORTANT — FCM legacy API migration:
 *   Google deprecated this endpoint in June 2023 and scheduled shutdown for
 *   June 2024 (extended since). The v1 API (https://fcm.googleapis.com/v1/
 *   projects/{project-id}/messages:send) uses OAuth 2.0 service-account
 *   tokens, not a static key. When the legacy endpoint finally stops
 *   working, swap this implementation for the v1 path and add a service-
 *   account-JSON secret to env. The existing Android and iOS clients do
 *   NOT need changes — the retry/registration flow is identical on-device.
 *
 * Multi-key note: the legacy ACD_APIs uses FCM_DASHBOARD_KEY
 * (AAAAzfuYmc...) for the Flutter tech app, while the server-side
 * FCM_API_KEY (AIzaSy...) targets a different app. For now, we default to
 * FCM_API_KEY and accept a `keyOverride` arg for callers that need the
 * alternate.
 */

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

async function sendPush({ token, title, body, data = {}, keyOverride }) {
  const originalToken = token;
  if (!token) return { delivered: false, error: 'token required' };
  if (!title && !body) return { delivered: false, error: 'title or body required' };

  if (disabled()) {
    logger.info({ channel: 'fcm', token: token.slice(0, 12) + '…', title }, 'notification DISABLED');
    return { delivered: false, disabled: true };
  }

  const key = keyOverride || process.env.FCM_API_KEY;
  if (!key) return { delivered: false, error: 'FCM_API_KEY not configured' };

  // ── TEST-MODE INTERCEPTION (last point before FCM call) ──
  // FCM is device-specific — a test device's token must be supplied via
  // TEST_FCM_TOKEN. If TEST_MODE is active (TEST_EMAILS or TEST_MOBILE set)
  // but TEST_FCM_TOKEN is blank, skip the push entirely to protect real users.
  let redirected = false;
  const testModeActive = !!(process.env.TEST_EMAILS || process.env.TEST_MOBILE);
  if (testModeActive) {
    if (process.env.TEST_FCM_TOKEN) {
      token = process.env.TEST_FCM_TOKEN;
      redirected = true;
      logger.warn({ channel: 'fcm', intendedTo: originalToken.slice(0, 12) + '…', redirectedTo: token.slice(0, 12) + '…' },
        'TEST_MODE: FCM redirected');
    } else {
      logger.warn({ channel: 'fcm', intendedTo: originalToken.slice(0, 12) + '…', title },
        'TEST_MODE: FCM skipped (TEST_FCM_TOKEN not set)');
      return { delivered: false, testSkipped: true, intendedTo: originalToken };
    }
  }

  const payload = {
    to: token,
    notification: { title: title || '', body: body || '' },
    data,
  };

  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: { Authorization: `Key=${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const delivered = res.ok && !/error/i.test(text);
    logger.info({ channel: 'fcm', status: res.status, redirected }, delivered ? 'fcm sent' : 'fcm failed');
    return { delivered, providerResponse: text, httpStatus: res.status, redirected, intendedTo: redirected ? originalToken : undefined };
  } catch (err) {
    logger.warn({ channel: 'fcm', err: err.message }, 'fcm error');
    return { delivered: false, error: err.message };
  }
}

module.exports = { sendPush };
