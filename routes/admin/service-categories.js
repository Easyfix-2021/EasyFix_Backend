const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/service-category.service');
const { modernOk, modernError } = require('../../utils/response');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('service_catg_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  service_catg_name: Joi.string().trim().min(2).max(200).required(),
  service_catg_desc: Joi.string().trim().max(500).allow('', null).optional(),
});

const updateBody = Joi.object({
  service_catg_name: Joi.string().trim().min(2).max(200).optional(),
  service_catg_desc: Joi.string().trim().max(500).allow('', null).optional(),
  is_active:         Joi.boolean().optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await svc.listCategories(req.query)); } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await svc.getCategoryById(Number(req.params.id));
    if (!row) return modernError(res, 404, 'Service Category not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    const created = await svc.createCategory(req.body);
    res.status(201); modernOk(res, created, 'Service Category added');
  } catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});

router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    const updated = await svc.updateCategory(Number(req.params.id), req.body);
    if (!updated) return modernError(res, 404, 'Service Category not found');
    modernOk(res, updated, 'Service Category updated');
  } catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});

router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    const ok = await svc.deactivateCategory(Number(req.params.id));
    if (!ok) return modernError(res, 404, 'Service Category not found');
    modernOk(res, { deactivated: true });
  } catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});

module.exports = router;
