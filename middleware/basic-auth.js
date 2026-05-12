const { pool } = require('../db');
const { legacyError } = require('../utils/response');

/*
 * HTTP Basic Auth against tbl_client_website for /api/integration/v1/*.
 * Legacy Dropwizard used @RolesAllowed per method — here we only authenticate;
 * role-style checks (who can POST jobs vs. just read) can layer on later.
 */
module.exports = async function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="EasyFix API"');
    return legacyError(res, 401, 'Unauthorized');
  }
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':', 2);
  if (!user || !pass) return legacyError(res, 401, 'Unauthorized');

  // Pull client_name in the same query — Decathlon-only branches in
  // /v1/easyfixers/availability-status-check gate on the literal name.
  const [[row]] = await pool.query(
    `SELECT cw.client_login_id, cw.client_id, cw.login_name, c.client_name
       FROM tbl_client_website cw
       LEFT JOIN tbl_client c ON c.client_id = cw.client_id
      WHERE cw.login_name = ? AND cw.login_password = ? AND cw.status = 1
      LIMIT 1`,
    [user, pass]
  );
  if (!row) return legacyError(res, 401, 'Invalid credentials');

  req.integrationClient = {
    id: row.client_id,
    name: row.client_name || null,
    loginName: row.login_name,
    loginId: row.client_login_id,
  };
  next();
};
