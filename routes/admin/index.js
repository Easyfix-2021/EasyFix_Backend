const router = require('express').Router();

const requireAuth = require('../../middleware/auth');
const { role } = require('../../middleware/role');
const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
const { pool } = require('../../db');

/*
 * Every /api/admin/* sub-resource inherits these gates:
 *   - requireAuth   → valid JWT, fresh tbl_user row on req.user
 *   - role(['admin']) → user_role must classify to 'admin' group
 *   - scope attach  → computes the hierarchy-unioned scope ONCE per
 *                     request and stashes on req.scope. Downstream
 *                     handlers + assertEntityInScope read this.
 *
 * Fine-grained role restrictions (e.g. finance-only reports) layer on with
 * roleByName() at the sub-route level.
 */
router.use(requireAuth);
router.use(role(['admin']));
router.use(async (req, _res, next) => {
  // Hierarchy-aware scope: own manage_* ∪ every direct/indirect report's
  // manage_*. Bypass roles (Admin/Finance) get `undefined` = no row filter.
  try { req.scope = await buildRequestScopeWithHierarchy(req, pool); }
  catch (e) { return next(e); }
  next();
});

router.use('/easyfixers',      require('./easyfixers'));
router.use('/zones',           require('./zones'));
router.use('/pincodes',        require('./pincodes'));
router.use('/cities',          require('./cities'));
router.use('/service-categories', require('./service-categories'));
router.use('/service-types',      require('./service-types'));
router.use('/document-types',     require('./document-types'));
router.use('/skill-levels',       require('./skill-levels'));
router.use('/verticals',          require('./verticals'));
router.use('/tools',              require('./tools'));
router.use('/rate-cards-b2b',     require('./rate-cards-b2b'));
router.use('/rate-cards-b2c',     require('./rate-cards-b2c'));
router.use('/deep-skills',     require('./deep-skills'));
router.use('/auto-allocation', require('./auto-allocation'));
router.use('/jobs',          require('./jobs'));
router.use('/auto-assign',   require('./auto-assign'));
router.use('/notifications', require('./notifications'));
router.use('/webhooks',        require('./webhooks'));
router.use('/finance',         require('./finance'));
router.use('/advances',        require('./advances'));
router.use('/clients',         require('./clients'));
router.use('/customers',       require('./customers'));
router.use('/menus',           require('./menus'));
router.use('/products',        require('./products'));
router.use('/users',           require('./users'));
router.use('/roles',           require('./roles'));
router.use('/rate-cards',      require('./rate-cards'));
router.use('/quotations',      require('./quotations'));
router.use('/questionnaires',  require('./questionnaires'));
router.use('/settings',        require('./settings'));
router.use('/reports',         require('./reports'));
router.use('/aux',             require('./auxiliary'));
router.use('/legacy',          require('./legacy'));
// router.use('/clients',        require('./clients'));     // later
// router.use('/users',          require('./users'));       // later

module.exports = router;
