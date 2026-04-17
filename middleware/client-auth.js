const jwt = require('jsonwebtoken');
const { findSpocById } = require('../services/client-auth.service');
const { modernError } = require('../utils/response');

module.exports = async function requireSpocAuth(req, res, next) {
  const token = req.cookies?.spocToken ||
    (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7));
  if (!token) return modernError(res, 401, 'authentication required');

  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return modernError(res, 401, e.name === 'TokenExpiredError' ? 'token expired' : 'invalid token'); }

  if (!String(payload.sub).startsWith('spoc:')) {
    return modernError(res, 403, 'not a client SPOC token');
  }
  const spocId = Number(String(payload.sub).slice(5));
  const spoc = await findSpocById(spocId);
  if (!spoc) return modernError(res, 401, 'SPOC not found or inactive');

  req.spoc = spoc;
  next();
};
