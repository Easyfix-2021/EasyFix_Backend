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

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  if (req.cookies && req.cookies.token) return req.cookies.token;
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
