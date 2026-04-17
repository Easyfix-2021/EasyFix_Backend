const router = require('express').Router();
const requireAuth = require('../../middleware/auth');

router.use('/lookup', require('./lookup'));

// File upload + delete require auth (lookup already applies its own).
router.use(requireAuth, require('./files'));

module.exports = router;
