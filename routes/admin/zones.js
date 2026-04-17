const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const zone = require('../../services/zone.service');
const { modernOk, modernError } = require('../../utils/response');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const searchQuery = Joi.object({
  q: Joi.string().allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(500).default(200),
  activeOnly: Joi.boolean().default(true),
});
const pincodeQuery = Joi.object({
  pincode: Joi.string().pattern(/^\d{6}$/).required(),
  limit: Joi.number().integer().min(1).max(500).default(200),
});

router.get('/', async (_req, res, next) => {
  try { modernOk(res, await zone.listZones()); } catch (e) { next(e); }
});

/*
 * Pincode-first lookup — listed BEFORE `/:id` so Express doesn't capture the
 * literal "by-pincode" as a zoneId. Same route-order gotcha as /auto-assign.
 */
router.get('/by-pincode', validate(pincodeQuery, 'query'), async (req, res, next) => {
  try {
    const items = await zone.searchEasyfixersByPincode(req.query.pincode, { limit: req.query.limit });
    modernOk(res, { pincode: req.query.pincode, easyfixers: items });
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await zone.getZoneDetail(req.params.id);
    if (!data) return modernError(res, 404, 'zone not found');
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.get('/:id/easyfixers', validate(idParam, 'params'), validate(searchQuery, 'query'), async (req, res, next) => {
  try {
    const items = await zone.searchEasyfixersInZone(req.params.id, req.query);
    modernOk(res, items);
  } catch (e) { next(e); }
});

module.exports = router;
