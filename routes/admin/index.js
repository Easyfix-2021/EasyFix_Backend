const router = require('express').Router();

const requireAuth = require('../../middleware/auth');
const { role } = require('../../middleware/role');

/*
 * Every /api/admin/* sub-resource inherits these two gates:
 *   - requireAuth   → valid JWT, fresh tbl_user row on req.user
 *   - role(['admin']) → user_role must classify to 'admin' group
 *
 * Fine-grained role restrictions (e.g. finance-only reports) layer on with
 * roleByName() at the sub-route level.
 */
router.use(requireAuth);
router.use(role(['admin']));

router.use('/easyfixers',    require('./easyfixers'));
router.use('/zones',         require('./zones'));
router.use('/jobs',          require('./jobs'));
router.use('/auto-assign',   require('./auto-assign'));
router.use('/notifications', require('./notifications'));
router.use('/webhooks',        require('./webhooks'));
router.use('/finance',         require('./finance'));
router.use('/clients',         require('./clients'));
router.use('/users',           require('./users'));
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
