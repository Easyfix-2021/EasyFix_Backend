const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const roleService = require('../../services/role.service');
const { modernOk, modernError } = require('../../utils/response');

/*
 * /api/admin/roles — Manage Roles settings surface.
 *
 * Mount inherits requireAuth + role(['admin']) at routes/admin/index.js.
 * Mutation routes additionally roleByName(['Admin']) so only canonical
 * Admins (role_id 2) can edit the role table itself — that's a privilege-
 * escalation surface and must not be open to every admin-group role.
 *
 * NOTE: Group classification (admin/client/mobile/default) is NOT editable
 * from this UI. It's a code-level mapping in ROLE_ID_TO_GROUP because the
 * group decides which route mount the role can hit — flipping a role from
 * 'client' to 'admin' from a form would be a real-time security event.
 * Adding a new role_id therefore requires (a) creating the row through
 * this UI, then (b) a code change to register its group, then (c) deploy.
 */

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({ roleId: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(roleService.SORTABLE_COLUMNS)).default('role_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

// menu_ids / menu_action_ids are int arrays validated for shape only. The
// service layer dedupes + sorts and tolerates junk (legacy data is messy).
const idArray = Joi.array().items(Joi.number().integer().positive()).default([]);

const createBody = Joi.object({
  role_name:       Joi.string().trim().min(2).max(100).required(),
  role_desc:       Joi.string().trim().max(500).allow('', null).optional(),
  menu_ids:        idArray.optional(),
  menu_action_ids: idArray.optional(),
});

const updateBody = Joi.object({
  role_name:       Joi.string().trim().min(2).max(100).optional(),
  role_desc:       Joi.string().trim().max(500).allow('', null).optional(),
  is_active:       Joi.boolean().optional(),
  // Explicitly nullable on update: passing `[]` clears all menu/action perms,
  // matching the legacy "save with nothing checked" behaviour.
  menu_ids:        Joi.array().items(Joi.number().integer().positive()).optional(),
  menu_action_ids: Joi.array().items(Joi.number().integer().positive()).optional(),
}).min(1);

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const data = await roleService.listRoles(req.query);
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.get('/:roleId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await roleService.getRoleByIdFull(Number(req.params.roleId));
    if (!row) return modernError(res, 404, 'Role not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

// ─── WRITE ───────────────────────────────────────────────────────────
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    const created = await roleService.createRole({
      ...req.body,
      createdBy: req.user?.user_id,
    });
    res.status(201);
    modernOk(res, created, 'Role added');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.patch('/:roleId',
  roleByName(['Admin']),
  validate(idParam, 'params'),
  validate(updateBody),
  async (req, res, next) => {
    try {
      const updated = await roleService.updateRole(
        Number(req.params.roleId), req.body, req.user?.user_id
      );
      if (!updated) return modernError(res, 404, 'Role not found');
      modernOk(res, updated, 'Role updated');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

router.delete('/:roleId', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    const ok = await roleService.deactivateRole(Number(req.params.roleId));
    if (!ok) return modernError(res, 404, 'Role not found');
    modernOk(res, { deactivated: true });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

module.exports = router;
