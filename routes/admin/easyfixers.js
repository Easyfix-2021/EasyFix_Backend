const router = require('express').Router();

const validate = require('../../middleware/validate');
const easyfixer = require('../../services/easyfixer.service');
const { modernOk, modernError } = require('../../utils/response');
const { listQuery, createBody, updateBody, statusBody, idParam } =
  require('../../validators/easyfixer.validator');
const { buildRequestScope, assertEntityInScope } = require('../../lib/scope');

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { rows, total } = await easyfixer.list({ ...req.query, scope });
    modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await easyfixer.getById(req.params.id);
    if (!row) return modernError(res, 404, 'easyfixer not found');
    // Row-level guard — return 404 (not 403) to avoid leaking existence
    // of out-of-scope efr_ids.
    const guard = assertEntityInScope(req, { city_id: row.efr_cityId });
    if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    // On create, the new row's city must be within the caller's scope.
    const guard = assertEntityInScope(req, { city_id: req.body.efr_cityId });
    if (!guard.ok) return modernError(res, 403, 'cannot create easyfixer in a city outside your scope');
    const created = await easyfixer.create(req.body, req.user);
    res.status(201);
    modernOk(res, created, 'easyfixer created');
  } catch (e) { next(e); }
});

router.put('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    const existing = await easyfixer.getById(req.params.id);
    if (!existing) return modernError(res, 404, 'easyfixer not found');
    const guard = assertEntityInScope(req, { city_id: existing.efr_cityId });
    if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
    const updated = await easyfixer.update(req.params.id, req.body, req.user);
    modernOk(res, updated, 'easyfixer updated');
  } catch (e) { next(e); }
});

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  try {
    const existing = await easyfixer.getById(req.params.id);
    if (!existing) return modernError(res, 404, 'easyfixer not found');
    const guard = assertEntityInScope(req, { city_id: existing.efr_cityId });
    if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
    const updated = await easyfixer.setStatus(req.params.id, req.body, req.user);
    modernOk(res, updated, `easyfixer ${req.body.active ? 'activated' : 'deactivated'}`);
  } catch (e) { next(e); }
});

module.exports = router;
