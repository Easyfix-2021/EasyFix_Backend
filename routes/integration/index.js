/*
 * Integration routes — replicate the legacy Dropwizard :8090 contract.
 * Mount point here: /api/integration
 * Public URL (via Nginx rewrite):  https://core.easyfix.in/v1/*
 *
 * Contract invariants (MUST NOT drift):
 *   - HTTP Basic Auth (NOT JWT). Credentials sourced from tbl_client_website / ClientLogin.
 *   - Response body shape: { status: "200" (STRING), message, data }
 *   - Date format: "DD-MM-YYYY HH:mm" (IST), never ISO-8601.
 *   - currentStatus is a human label ("Unconfirmed"), NOT the numeric code from tbl_job.
 *   - Multipart upload field names: `file`, `JobId` (capital J, capital I).
 *   - Endpoints to replicate: /v1/services, /v1/jobs/, /v1/jobs/jobStatus,
 *                             /v1/jobImage/addJobImages, /v1/cities
 *
 * Any change to the response body is a breaking change for external clients
 * (e.g. Decathlon). Run the shadow-traffic diff harness before touching these.
 */

const router = require('express').Router();
const { legacyOk } = require('../../utils/response');

// Public health check (no auth) — canary for legacy shape
router.get('/_ping', (_req, res) => {
  legacyOk(res, { ping: 'pong' });
});

// /api/integration/v1/* — HTTP Basic Auth, Dropwizard-contract replacement
router.use('/v1', require('./v1'));

module.exports = router;
