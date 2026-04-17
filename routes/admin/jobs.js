const router = require('express').Router();

const validate = require('../../middleware/validate');
const job = require('../../services/job.service');
const { modernOk, modernError } = require('../../utils/response');
const {
  listQuery, createBody, updateBody, statusBody, assignBody, ownerBody, idParam,
} = require('../../validators/job.validator');

// Upload sub-router (POST /upload) — isolated because of multer middleware.
router.use(require('./jobs-upload'));

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { rows, total } = await job.list(req.query);
    modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/counts
 * Returns status-bucket totals + grand total in ONE query. Replaces the
 * dashboard's 6 parallel list-with-limit-1 calls (which each spent 2 DB
 * connections on COUNT + data queries — ~12 concurrent connections just for
 * stats, enough to saturate a 20-connection pool when combined with /auth/me
 * and recent-jobs on the same page load). Single GROUP BY = 1 connection.
 */
router.get('/counts', async (_req, res, next) => {
  try {
    const counts = await job.getStatusCounts();
    modernOk(res, counts);
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await job.getById(req.params.id);
    if (!row) return modernError(res, 404, 'job not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const created = await job.create(req.body, req.user);
    res.status(201);
    modernOk(res, created, 'job created');
  } catch (e) { next(e); }
});

router.put('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    const updated = await job.update(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job updated');
  } catch (e) { next(e); }
});

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  try {
    const updated = await job.setStatus(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job status updated');
  } catch (e) { next(e); }
});

router.patch('/:id/assign', validate(idParam, 'params'), validate(assignBody), async (req, res, next) => {
  try {
    const updated = await job.assign(req.params.id, req.body, req.user);
    modernOk(res, updated, 'technician assigned');
  } catch (e) { next(e); }
});

router.patch('/:id/owner', validate(idParam, 'params'), validate(ownerBody), async (req, res, next) => {
  try {
    const updated = await job.changeOwner(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job owner changed');
  } catch (e) { next(e); }
});

module.exports = router;
