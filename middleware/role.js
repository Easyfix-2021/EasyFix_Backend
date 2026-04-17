/*
 * Role-based access control middleware.
 *
 * Usage:
 *   router.get('/x', requireAuth, role(['admin']), handler)
 *   router.get('/y', requireAuth, role(['admin', 'client']), handler)
 *   router.get('/z', requireAuth, roleByName(['Admin', 'Finance']), handler)
 *
 * Semantics:
 *   - 401 is owned by auth middleware (missing/invalid JWT).
 *   - 403 is owned by role middleware (token valid but user lacks access).
 *   - Unknown/unclassified roles fail closed.
 *
 * Group guards (`role(...)`) use the static ROLE_ID_TO_GROUP mapping in
 * services/role.service.js. Name guards (`roleByName(...)`) do a case-insensitive
 * exact match against tbl_role.role_name — use for fine-grained ACL inside a
 * group (e.g. only "Finance" within admin).
 */

const { getRoleById } = require('../services/role.service');
const { modernError } = require('../utils/response');

const VALID_GROUPS = new Set(['admin', 'client', 'mobile', 'default']);

function role(allowedGroups) {
  if (!Array.isArray(allowedGroups) || allowedGroups.length === 0) {
    throw new Error('role() requires a non-empty array of allowed groups');
  }
  for (const g of allowedGroups) {
    if (!VALID_GROUPS.has(g)) {
      throw new Error(`role(): unknown group "${g}". Valid: ${[...VALID_GROUPS].join(', ')}`);
    }
  }
  const allowed = new Set(allowedGroups);

  return async function roleGuard(req, res, next) {
    if (!req.user) return modernError(res, 401, 'authentication required');

    const roleRow = await getRoleById(req.user.user_role);
    if (!roleRow) {
      return modernError(res, 403, 'role not found — access denied');
    }
    if (!roleRow.role_status) {
      return modernError(res, 403, 'role is inactive — access denied');
    }
    if (!allowed.has(roleRow.group)) {
      return modernError(res, 403, 'insufficient permissions', {
        requiredGroups: [...allowed],
        actualGroup: roleRow.group,
        actualRole: roleRow.role_name,
      });
    }

    req.userRole = roleRow;
    return next();
  };
}

function roleByName(allowedNames) {
  if (!Array.isArray(allowedNames) || allowedNames.length === 0) {
    throw new Error('roleByName() requires a non-empty array of role names');
  }
  const allowed = new Set(allowedNames.map((n) => n.toLowerCase()));

  return async function roleByNameGuard(req, res, next) {
    if (!req.user) return modernError(res, 401, 'authentication required');

    const roleRow = await getRoleById(req.user.user_role);
    if (!roleRow || !roleRow.role_status) {
      return modernError(res, 403, 'role not found or inactive — access denied');
    }
    if (!allowed.has(roleRow.role_name.toLowerCase())) {
      return modernError(res, 403, 'insufficient permissions', {
        requiredNames: [...allowed],
        actualRole: roleRow.role_name,
      });
    }

    req.userRole = roleRow;
    return next();
  };
}

module.exports = { role, roleByName };
