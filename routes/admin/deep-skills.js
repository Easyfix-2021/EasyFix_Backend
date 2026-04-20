const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const ds = require('../../services/deep-skill.service');
const { modernOk, modernError } = require('../../utils/response');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const optIdParam = Joi.object({
  id:       Joi.number().integer().positive().required(),
  optionId: Joi.number().integer().positive().required(),
});
const listQuery = Joi.object({
  categoryId:      Joi.number().integer().optional(),
  serviceTypeId:   Joi.number().integer().optional(),
  includeInactive: Joi.boolean().default(false),
});
const createBody = Joi.object({
  category_id:            Joi.number().integer().required(),
  service_type_id:        Joi.number().integer().required(),
  deepskill_name:         Joi.string().min(1).max(255).required(),
  deepskill_description:  Joi.string().max(1000).allow('', null).optional(),
  deepskill_image:        Joi.string().max(500).allow('', null).optional(),
});
const updateBody = Joi.object({
  category_id:            Joi.number().integer().optional(),
  service_type_id:        Joi.number().integer().optional(),
  deepskill_name:         Joi.string().min(1).max(255).optional(),
  deepskill_description:  Joi.string().max(1000).allow('', null).optional(),
  deepskill_image:        Joi.string().max(500).allow('', null).optional(),
  status:                 Joi.number().integer().valid(0, 1).optional(),
}).min(1);
const optionBody      = Joi.object({ skill_option: Joi.string().min(1).max(500).required() });
const optionPatchBody = Joi.object({
  skill_option: Joi.string().min(1).max(500).optional(),
  status:       Joi.number().integer().valid(0, 1).optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await ds.list(req.query)); } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await ds.getById(req.params.id);
    if (!data) return modernError(res, 404, 'deep skill not found');
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const created = await ds.create(req.body, req.user);
    res.status(201);
    modernOk(res, created, 'deep skill created');
  } catch (e) { next(e); }
});

router.patch('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try { modernOk(res, await ds.update(req.params.id, req.body), 'deep skill updated'); } catch (e) { next(e); }
});

// Soft-delete / deactivate — we never hard-delete because tbl_efr_deepskill_mapping
// holds FKs back to deepskill_id for every technician who ever had this skill.
router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { modernOk(res, await ds.setStatus(req.params.id, false), 'deep skill deactivated'); } catch (e) { next(e); }
});

// ─── Options (nested under a deep skill) ────────────────────────────
router.post('/:id/options', validate(idParam, 'params'), validate(optionBody), async (req, res, next) => {
  try { modernOk(res, await ds.addOption(req.params.id, req.body), 'option added'); } catch (e) { next(e); }
});

router.patch('/:id/options/:optionId', validate(optIdParam, 'params'), validate(optionPatchBody), async (req, res, next) => {
  try { modernOk(res, await ds.updateOption(req.params.id, req.params.optionId, req.body), 'option updated'); } catch (e) { next(e); }
});

router.delete('/:id/options/:optionId', validate(optIdParam, 'params'), async (req, res, next) => {
  try { modernOk(res, await ds.deleteOption(req.params.id, req.params.optionId), 'option removed'); } catch (e) { next(e); }
});

module.exports = router;
