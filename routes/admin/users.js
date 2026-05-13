const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const userService = require('../../services/user.service');
const { modernOk, modernError } = require('../../utils/response');

/*
 * /api/admin/users — Manage Users settings surface.
 *
 * Mount inherits:
 *   - requireAuth + role(['admin'])  via routes/admin/index.js
 *
 * Mutation routes additionally roleByName(['Admin']) — only the canonical
 * Admin role can create / edit / deactivate users. Other admin-group roles
 * (Finance, Project Manager, etc.) can READ for context but not mutate.
 *
 * Internal-user gate (user_type_id = 5) is enforced in the service layer.
 */

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({ userId: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  roleId:          Joi.number().integer().positive().optional(),
  cityId:          Joi.number().integer().positive().optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(userService.SORTABLE_COLUMNS)).default('user_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  user_name:      Joi.string().trim().min(2).max(200).required(),
  official_email: Joi.string().trim().lowercase().email().max(255).required(),
  mobile_no:      Joi.string().trim().pattern(/^[0-9]{10}$/).required(),
  alternate_no:   Joi.string().trim().pattern(/^[0-9]{10}$/).allow('', null).optional(),
  user_role:      Joi.number().integer().positive().required(),
  city_id:        Joi.number().integer().positive().allow(null).optional(),
  // RBAC scope CSVs — comma-separated id strings (legacy varchar; no
  // FK enforcement). The literal "0" is a wildcard meaning "all" —
  // see lib/scope.js. We don't validate contents beyond shape so that
  // legacy callers and bulk-imports keep working.
  manage_clients:    Joi.string().allow('', null).optional(),
  manage_cities:     Joi.string().allow('', null).optional(),
  manage_states:     Joi.string().allow('', null).optional(),
  manage_verticals:  Joi.string().allow('', null).optional(),
  reporting_manager: Joi.number().integer().positive().allow(null).optional(),
});

const updateBody = Joi.object({
  mobile_no:         Joi.string().trim().pattern(/^[0-9]{10}$/).optional(),
  alternate_no:      Joi.string().trim().pattern(/^[0-9]{10}$/).allow('', null).optional(),
  user_role:         Joi.number().integer().positive().optional(),
  city_id:           Joi.number().integer().positive().allow(null).optional(),
  manage_clients:    Joi.string().allow('', null).optional(),
  manage_cities:     Joi.string().allow('', null).optional(),
  manage_states:     Joi.string().allow('', null).optional(),
  manage_verticals:  Joi.string().allow('', null).optional(),
  reporting_manager: Joi.number().integer().positive().allow(null).optional(),
  is_active:         Joi.boolean().optional(),
}).min(1);

// ─── Real-time mobile uniqueness probe ──────────────────────────────
// Mounted BEFORE /:userId so Express doesn't try to parse "check-mobile"
// as an integer user id. Used by the Add/Edit User form for inline
// validation — the operator finds out a mobile is taken before clicking
// Save. Read-only, idempotent; safe for any admin-group user.
const checkMobileQuery = Joi.object({
  mobile:        Joi.string().trim().pattern(/^[0-9]{10}$/).required(),
  excludeUserId: Joi.number().integer().positive().optional(),
});
router.get('/check-mobile', validate(checkMobileQuery, 'query'), async (req, res, next) => {
  try {
    const result = await userService.isMobileTakenByAnother(
      req.query.mobile, req.query.excludeUserId
    );
    modernOk(res, result);
  } catch (e) { next(e); }
});

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const data = await userService.listUsers(req.query);
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.get('/:userId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await userService.getUserById(Number(req.params.userId));
    if (!row) return modernError(res, 404, 'User not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

// ─── Hierarchy graph — Users → Hierarchy ────────────────────────────
// Returns a tree rooted at `userId` containing every direct + indirect
// report (BFS expanded server-side via DFS over tbl_user.reporting_manager)
// plus the chain of ancestors above them. Powers the Users → Hierarchy
// graph view. The user can be looked up by id or by official_email
// before hitting this endpoint via the standard list filter.
router.get('/:userId/hierarchy', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const tree = await userService.buildHierarchyTree(Number(req.params.userId));
    if (!tree) return modernError(res, 404, 'User not found');
    modernOk(res, tree);
  } catch (e) { next(e); }
});

// ─── WRITE ───────────────────────────────────────────────────────────
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    const created = await userService.createUser({
      ...req.body,
      createdBy: req.user?.user_id,
    });
    res.status(201);
    modernOk(res, created, 'User added');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.patch('/:userId',
  roleByName(['Admin']),
  validate(idParam, 'params'),
  validate(updateBody),
  async (req, res, next) => {
    try {
      const updated = await userService.updateUser(
        Number(req.params.userId), req.body, req.user?.user_id
      );
      if (!updated) return modernError(res, 404, 'User not found');
      modernOk(res, updated, 'User updated');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

router.delete('/:userId', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    const ok = await userService.deactivateUser(Number(req.params.userId), req.user?.user_id);
    if (!ok) return modernError(res, 404, 'User not found');
    modernOk(res, { deactivated: true });
  } catch (e) { next(e); }
});

module.exports = router;
