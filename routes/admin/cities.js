const router = require('express').Router();
const Joi    = require('joi');

const validate      = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const city     = require('../../services/city.service');
const { modernOk, modernError } = require('../../utils/response');
const logger   = require('../../logger');

/*
 * ─── PERMISSIONS ─────────────────────────────────────────────────────
 * Until 2026-09-09 this file had NO action check at all: every route
 * inherited only requireAuth + role(['admin']) from routes/admin/index.js,
 * so any of the ten admin-group roles could add, edit or deactivate a city
 * regardless of what Manage Role said. The keys below already exist in
 * menu_action (ids 16 and 17, menu_id 14 = 'city') and are already granted
 * to Admin / Project Manager / Admin Supply — the grants were being made
 * and then ignored.
 *
 * isCityApprove is seeded by migrations/executed/2026-09-09-city-approval-flow.sql.
 * Until that migration runs, approve/reject answer 403 for everyone, which
 * is the correct fail-closed direction for a brand-new privileged action.
 *
 * The GETs stay ungated deliberately: reading the city master is what
 * every dropdown in the CRM does.
 */
const requireCityAdd     = requireAction('isCityAddNew');   // menu_action 16
const requireCityEdit    = requireAction('isCityEdit');     // menu_action 17
const requireCityApprove = requireAction('isCityApprove');  // seeded by the migration

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({ cityId: Joi.number().integer().positive().required() });

const pendingQuery = Joi.object({
  limit:  Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
});

/*
 * MANDATORY, not optional. A rejection is a MERGE: it repoints every row
 * that referenced the rejected city. There is no meaningful "reject with no
 * replacement" — that would strand the rows the pending city was created to
 * hold, which is the failure this whole flow exists to prevent.
 */
const rejectBody = Joi.object({
  replacement_city_id: Joi.number().integer().positive().required(),
});

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  stateId:         Joi.number().integer().positive().optional(),
  // Show only cities a technician created on the fly (created_by_type=technician).
  createdByTech:   Joi.boolean().default(false),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  // Whitelist comes from the service layer so the two stay in lockstep —
  // adding a new sortable column requires touching exactly one place.
  sortBy:          Joi.string().valid(...Object.keys(city.SORTABLE_COLUMNS)).default('city_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  city_name:         Joi.string().trim().min(2).max(100).required(),
  state_id:          Joi.number().integer().positive().required(),
  district:          Joi.string().trim().max(100).allow('', null).optional(),
  tier:              Joi.string().trim().max(20).allow('', null).optional(),
  reference_pincode: Joi.string().trim().pattern(/^\d{6}$/).allow('', null).optional(),
});

const updateBody = Joi.object({
  city_name:         Joi.string().trim().min(2).max(100).optional(),
  state_id:          Joi.number().integer().positive().optional(),
  district:          Joi.string().trim().max(100).allow('', null).optional(),
  tier:              Joi.string().trim().max(20).allow('', null).optional(),
  reference_pincode: Joi.string().trim().pattern(/^\d{6}$/).allow('', null).optional(),
  is_active:         Joi.boolean().optional(),
}).min(1);

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List cities · q=' + (req.query.q || '') + ' stateId=' + (req.query.stateId || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    const data = await city.listCities(req.query);
    logger.info('Returning ' + (data.items ? data.items.length : (Array.isArray(data) ? data.length : 0)) + ' cities');
    modernOk(res, data);
  } catch (e) { next(e); }
});

/*
 * MUST stay above GET /:cityId. Express matches in declaration order, so
 * declared after it, '/pending' would be captured as :cityId and answered
 * with a Joi 400 ("cityId must be a number") instead of the queue.
 *
 * ACTION-GATED, unlike the other two GETs. Reading the city master (GET / and
 * GET /:cityId) is what every dropdown in the CRM does, so gating those would
 * break unrelated screens. This one is different: it is an approval WORKLIST,
 * not a lookup. Nothing but the Manage Cities pending tab calls it, that tab
 * is itself gated on isCityApprove, and the rows carry the identity of whoever
 * triggered each automatic creation. Gating it makes the permission boundary
 * real rather than a render hint — a non-approver now gets a 403 instead of
 * the queue plus a 403 only when they act on it.
 */
router.get('/pending', requireCityApprove, validate(pendingQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List pending cities · limit=' + req.query.limit + ' offset=' + req.query.offset);
    const data = await city.listPendingCities(req.query);
    logger.info('Returning ' + data.items.length + ' pending cities · total=' + data.total);
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.get('/:cityId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get city · id=' + req.params.cityId);
    const row = await city.getCityById(Number(req.params.cityId));
    if (!row) logger.warn('City not found · id=' + req.params.cityId);
    if (!row) return modernError(res, 404, 'City not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

// ─── WRITE ───────────────────────────────────────────────────────────
router.post('/', requireCityAdd, validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create city · name=' + req.body.city_name + ' stateId=' + req.body.state_id);
    const created = await city.createCity(req.body);
    logger.info('City created · id=' + (created && created.city_id));
    res.status(201);
    modernOk(res, created, 'City added');
  } catch (e) {
    if (e.status) logger.warn('Create city failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.patch('/:cityId',
  requireCityEdit,
  validate(idParam, 'params'),
  validate(updateBody),
  async (req, res, next) => {
    try {
      logger.info('Update city · id=' + req.params.cityId + ' fields=' + Object.keys(req.body).join(','));
      const updated = await city.updateCity(Number(req.params.cityId), req.body);
      if (!updated) logger.warn('City not found · id=' + req.params.cityId);
      if (!updated) return modernError(res, 404, 'City not found');
      logger.info('City updated · id=' + req.params.cityId);
      modernOk(res, updated, 'City updated');
    } catch (e) {
      if (e.status) logger.warn('Update city failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

// Deactivation is an edit to the city master, not a separate privilege —
// isCityEdit is the key the legacy CRM gates the same button with.
router.delete('/:cityId', requireCityEdit, validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Deactivate city · id=' + req.params.cityId);
    const ok = await city.deactivateCity(Number(req.params.cityId));
    if (!ok) logger.warn('City not found · id=' + req.params.cityId);
    if (!ok) return modernError(res, 404, 'City not found');
    logger.info('City deactivated · id=' + req.params.cityId);
    modernOk(res, { deactivated: true });
  } catch (e) { next(e); }
});

// ─── APPROVE / REJECT ────────────────────────────────────────────────
router.post('/:cityId/approve',
  requireCityApprove,
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Approve city · id=' + req.params.cityId + ' by=' + (req.user && req.user.user_id));
      const row = await city.approveCity(Number(req.params.cityId), req.user && req.user.user_id);
      logger.info('City approved · id=' + req.params.cityId);
      modernOk(res, row, 'City approved');
    } catch (e) {
      if (e.status) logger.warn('Approve city failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

router.post('/:cityId/reject',
  requireCityApprove,
  validate(idParam, 'params'),
  validate(rejectBody),
  async (req, res, next) => {
    try {
      logger.info('Reject city · id=' + req.params.cityId + ' → ' + req.body.replacement_city_id + ' by=' + (req.user && req.user.user_id));
      const result = await city.rejectCity(
        Number(req.params.cityId), Number(req.body.replacement_city_id), req.user && req.user.user_id
      );
      logger.info('City rejected · id=' + req.params.cityId + ' rows=' + result.rows_moved);
      // `moved` is the blast radius, per table. An operator merging a city
      // that turns out to hold 40,000 addresses should see that number.
      modernOk(res, result, `City rejected · ${result.rows_moved} row(s) merged into city ${result.merged_into_city_id}`);
    } catch (e) {
      if (e.status) logger.warn('Reject city failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

module.exports = router;
