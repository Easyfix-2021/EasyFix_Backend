const router = require('express').Router();

const requireAuth = require('../../middleware/auth');
const { role } = require('../../middleware/role');
const validate = require('../../middleware/validate');
const lookup = require('../../services/lookup.service');
const { modernOk } = require('../../utils/response');
const {
  citiesQuery, serviceTypesQuery, clientsQuery, clientServicesQuery,
  usersQuery, banksQuery, simpleIncludeInactive,
} = require('../../validators/lookup.validator');

/*
 * All routes under /api/shared/lookup require a valid JWT.
 * Most are open to any authenticated user (dropdowns for forms).
 * Admin-sensitive lookups (clients, client-services, users) additionally
 * require role(['admin']) — these would leak data if shown to a client SPOC
 * or a technician.
 */

router.use(requireAuth);

// ─── Open to any authenticated principal ────────────────────────────
router.get('/cities',             validate(citiesQuery, 'query'),          async (req, res, next) => {
  try { modernOk(res, await lookup.cities(req.query)); } catch (e) { next(e); }
});

router.get('/states',             async (_req, res, next) => {
  try { modernOk(res, await lookup.states()); } catch (e) { next(e); }
});

router.get('/service-categories', validate(simpleIncludeInactive, 'query'), async (req, res, next) => {
  try { modernOk(res, await lookup.serviceCategories(req.query)); } catch (e) { next(e); }
});

router.get('/service-types',      validate(serviceTypesQuery, 'query'),    async (req, res, next) => {
  try { modernOk(res, await lookup.serviceTypes(req.query)); } catch (e) { next(e); }
});

router.get('/cancel-reasons',     async (_req, res, next) => {
  try { modernOk(res, await lookup.cancelReasons()); } catch (e) { next(e); }
});

router.get('/reschedule-reasons', async (_req, res, next) => {
  try { modernOk(res, await lookup.rescheduleReasons()); } catch (e) { next(e); }
});

router.get('/banks',              validate(banksQuery, 'query'),           async (req, res, next) => {
  try { modernOk(res, await lookup.banks(req.query)); } catch (e) { next(e); }
});

router.get('/document-types',     validate(simpleIncludeInactive, 'query'), async (req, res, next) => {
  try { modernOk(res, await lookup.documentTypes(req.query)); } catch (e) { next(e); }
});

// ─── Admin-only ─────────────────────────────────────────────────────
// The client + user lists are admin-facing dropdowns. A ClientDashboard User
// MUST NOT be able to enumerate all clients or internal staff — that's a
// data-leak bug waiting to happen. /api/client/* will expose a scoped view.
router.get('/clients',          role(['admin']), validate(clientsQuery, 'query'),        async (req, res, next) => {
  try { modernOk(res, await lookup.clients(req.query)); } catch (e) { next(e); }
});

router.get('/client-services',  role(['admin']), validate(clientServicesQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await lookup.clientServices(req.query)); } catch (e) { next(e); }
});

router.get('/users',            role(['admin']), validate(usersQuery, 'query'),          async (req, res, next) => {
  try { modernOk(res, await lookup.users(req.query)); } catch (e) { next(e); }
});

// Compact easyfixer picker for "Assign Technician" dropdowns. Admin-only: client
// SPOCs and technicians themselves have no business enumerating the full bench.
router.get('/easyfixers',       role(['admin']),                                          async (req, res, next) => {
  try { modernOk(res, await lookup.easyfixers(req.query)); } catch (e) { next(e); }
});

module.exports = router;
