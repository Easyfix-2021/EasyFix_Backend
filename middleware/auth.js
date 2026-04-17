/*
 * JWT authentication middleware.
 * Applied to /api/admin, /api/client, /api/mobile, /api/shared routes.
 * NEVER applied to /api/integration/* (those use HTTP Basic Auth).
 *
 * Populates req.user with a fresh row from tbl_user.
 */

const { verifyToken } = require('../utils/jwt');
const { findUserById } = require('../services/auth.service');
const { modernError } = require('../utils/response');

/*
 * Bearer-header only. We intentionally do NOT fall back to the `token` cookie.
 * Why:
 *   - Browsers auto-attach cookies to any request to the same origin (including
 *     a user typing the URL into the address bar) → direct visits to the API
 *     would return authenticated data without any JS involvement.
 *   - Worse, any third-party site could POST to our API with `credentials:
 *     include`; the cookie rides along and the server thinks the real user
 *     authored the request — classic CSRF.
 * Bearer-in-Authorization can only be set by our own JS (it reads the JWT from
 * localStorage), so it doubles as a same-origin proof. The cookie remains in
 * the browser as a convenience (set by the login endpoint for possible future
 * server-rendered pages) but is no longer a valid credential on its own.
 */
function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return modernError(res, 401, 'authentication required');

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    const reason = err.name === 'TokenExpiredError' ? 'token expired' : 'invalid token';
    return modernError(res, 401, reason);
  }

  const user = await findUserById(payload.sub);
  if (!user) return modernError(res, 401, 'user not found or inactive');

  req.user = user;
  req.tokenPayload = payload;
  return next();
}

module.exports = requireAuth;
