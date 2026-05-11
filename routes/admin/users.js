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
  // manage_clients / manage_cities / manage_states — comma-separated id strings
  // (legacy varchar; no FK enforcement). We don't validate the contents to
  // stay flexible with how legacy callers populate them; if it becomes a
  // problem we tighten here.
  manage_clients: Joi.string().allow('', null).optional(),
  manage_cities:  Joi.string().allow('', null).optional(),
  manage_states:  Joi.string().allow('', null).optional(),
});

const updateBody = Joi.object({
  mobile_no:      Joi.string().trim().pattern(/^[0-9]{10}$/).optional(),
  alternate_no:   Joi.string().trim().pattern(/^[0-9]{10}$/).allow('', null).optional(),
  user_role:      Joi.number().integer().positive().optional(),
  city_id:        Joi.number().integer().positive().allow(null).optional(),
  manage_clients: Joi.string().allow('', null).optional(),
  manage_cities:  Joi.string().allow('', null).optional(),
  manage_states:  Joi.string().allow('', null).optional(),
  is_active:      Joi.boolean().optional(),
}).min(1);

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
