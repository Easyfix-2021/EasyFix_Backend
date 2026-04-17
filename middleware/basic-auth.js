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

  const [[row]] = await pool.query(
    `SELECT client_login_id, client_id, login_name FROM tbl_client_website
      WHERE login_name = ? AND login_password = ? AND status = 1 LIMIT 1`,
    [user, pass]
  );
  if (!row) return legacyError(res, 401, 'Invalid credentials');

  req.integrationClient = { id: row.client_id, loginName: row.login_name, loginId: row.client_login_id };
  next();
};
