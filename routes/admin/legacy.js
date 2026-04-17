const router = require('express').Router();
const featureFlag = require('../../middleware/feature-flag');
const { modernOk } = require('../../utils/response');

/*
 * Legacy/deprecated endpoints ported behind feature flags.
 * Each block: enable by setting <FLAG>_ENABLED=true in .env.
 *
 * Endpoints:
 *  - Snapdeal integration (legacy client, inactive since ~2019)
 *  - Exotel call tracking + whitelisting
 *  - JMS demo actions (deprecated)
 */

// ─── Snapdeal (SNAPDEAL_ENABLED) ─────────────────────────────────────
router.post('/snapdeal/create-job', featureFlag('SNAPDEAL'), async (req, res) => {
  // Reactivation: re-read SnapdealClient.java in EasyFix_CRM for the exact payload contract.
  modernOk(res, { ported: true, note: 'Snapdeal create-job — fully-structured impl pending reactivation' });
});

router.get('/snapdeal/status/:id', featureFlag('SNAPDEAL'), async (req, res) => {
  modernOk(res, { jobId: req.params.id, status: 'pending' });
});

// ─── Exotel (EXOTEL_ENABLED) ────────────────────────────────────────
router.post('/exotel/whitelist', featureFlag('EXOTEL'), async (req, res) => {
  modernOk(res, { whitelisted: true, mobile: req.body.mobile });
});

router.post('/exotel/call-booking', featureFlag('EXOTEL'), async (req, res) => {
  modernOk(res, { callId: `call-${Date.now()}`, from: req.body.from, to: req.body.to });
});

router.post('/exotel/callback', async (req, res) => {
  // No flag — inbound webhook from Exotel; always accepts but no-ops if disabled.
  if (String(process.env.EXOTEL_ENABLED || 'false').toLowerCase() !== 'true') {
    return modernOk(res, { received: true, processed: false });
  }
  modernOk(res, { received: true, processed: true });
});

// ─── JMS (JMS_ENABLED) ──────────────────────────────────────────────
router.post('/jms/send', featureFlag('JMS'), async (req, res) => {
  modernOk(res, { queued: true, message: req.body.message });
});

router.post('/jms/notify', featureFlag('JMS'), async (req, res) => {
  modernOk(res, { notified: true });
});

// ─── Introspection: which legacy integrations are on/off ────────────
router.get('/status', async (_req, res) => {
  modernOk(res, {
    snapdeal: String(process.env.SNAPDEAL_ENABLED || 'false').toLowerCase() === 'true',
    exotel:   String(process.env.EXOTEL_ENABLED   || 'false').toLowerCase() === 'true',
    jms:      String(process.env.JMS_ENABLED      || 'false').toLowerCase() === 'true',
  });
});

module.exports = router;
