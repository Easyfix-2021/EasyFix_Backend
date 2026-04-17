/*
 * Two response shapes coexist in this backend:
 *
 *  modern  — used by /api/admin, /api/client, /api/mobile, /api/shared, /api/auth
 *              { success: true,  data: ..., message?: ... }
 *              { success: false, error: "msg", details?: {...} }
 *
 *  legacy  — used by /api/integration/v1/* ONLY
 *              Mirrors the Dropwizard :8090 contract exactly, byte-for-byte.
 *              { status: "200", message: "OK", data: {...} }     // note: status is a STRING
 *
 * Route groups MUST use the formatter matching their contract.
 * Never mix. Never apply a global response middleware that rewrites either shape.
 */

function modernOk(res, data, message) {
  const body = { success: true, data };
  if (message) body.message = message;
  return res.json(body);
}

function modernError(res, status, error, details) {
  const body = { success: false, error };
  if (details) body.details = details;
  return res.status(status).json(body);
}

function legacyOk(res, data, message = 'OK') {
  return res.json({ status: '200', message, data });
}

function legacyError(res, httpStatus, message, data = null) {
  return res.status(httpStatus).json({
    status: String(httpStatus),
    message,
    data,
  });
}

module.exports = { modernOk, modernError, legacyOk, legacyError };
