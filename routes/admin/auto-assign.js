const router = require('express').Router();

const validate = require('../../middleware/validate');
const autoAssign = require('../../services/auto-assign.service');
const { modernOk } = require('../../utils/response');
const { candidatesQuery, bulkQuery, jobIdParam } = require('../../validators/auto-assign.validator');

// NOTE: route order matters — `/bulk` must come BEFORE `/:jobId`,
// otherwise Express interprets "bulk" as a jobId param and the numeric
// validator rejects it with 400.

// POST /api/admin/auto-assign/bulk?limit=50&dryRun=true
router.post('/bulk',
  validate(bulkQuery, 'query'),
  async (req, res, next) => {
    try {
      const out = await autoAssign.bulkAssignUnassigned(req.query, req.user);
      modernOk(res, out, req.query.dryRun ? 'bulk dry-run complete' : 'bulk auto-assign complete');
    } catch (e) { next(e); }
  }
);

// GET /api/admin/auto-assign/:jobId/candidates?limit=10&ignoreDistance=false
router.get('/:jobId/candidates',
  validate(jobIdParam, 'params'),
  validate(candidatesQuery, 'query'),
  async (req, res, next) => {
    try {
      const out = await autoAssign.getCandidates(req.params.jobId, req.query);
      modernOk(res, out);
    } catch (e) { next(e); }
  }
);

// POST /api/admin/auto-assign/:jobId
router.post('/:jobId',
  validate(jobIdParam, 'params'),
  async (req, res, next) => {
    try {
      const out = await autoAssign.assignTopCandidate(req.params.jobId, req.user);
      modernOk(res, out, 'auto-assigned');
    } catch (e) { next(e); }
  }
);

module.exports = router;
