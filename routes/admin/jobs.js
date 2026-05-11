const router = require('express').Router();

const validate = require('../../middleware/validate');
const job = require('../../services/job.service');
const candidateRanking = require('../../services/candidate-ranking.service');
const { modernOk, modernError } = require('../../utils/response');
const {
  listQuery, createBody, updateBody, statusBody, assignBody, ownerBody, idParam,
} = require('../../validators/job.validator');

// Upload sub-router (POST /upload) — isolated because of multer middleware.
router.use(require('./jobs-upload'));

/*
 * GET /api/admin/jobs/:id/candidates?limit=50
 *
 * Returns ranked technicians for the Assign / Reassign modal on /my-orders
 * and /jobs. Same layered pipeline used by on-create auto-assign — see
 * services/candidate-ranking.service.js. Returns per-candidate breakdowns
 * (Rating, TAT, SDA, Worked-for-Client, Worked-for-Vertical, Attendance)
 * plus account balance for sorting tie-break.
 *
 * If no technician passes the deep-skill filter, the response includes
 * `note: 'no_deep_skill_match'` and the candidates list is the same query
 * with the skill predicate dropped — so the modal can show a banner and
 * still let ops pick someone.
 *
 * Listed BEFORE `/:id/assign` and other `/:id/*` so Express matches the
 * literal `candidates` segment first.
 */
router.get('/:id/candidates', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const result = await candidateRanking.rankCandidatesForJob(req.params.id, { limit });
    modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

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
/*
 * Accepts optional `?ownerId=<user_id>` to scope the buckets to jobs owned
 * by that user (drives the "My Orders" sidebar flow on the CRM). Invalid or
 * missing ownerId falls through to org-wide counts — same response shape,
 * different WHERE clause. Frontend passes `ownerId = currentUser.user_id`
 * when it detects `?scope=mine` on the URL.
 */
router.get('/counts', async (req, res, next) => {
  try {
    const ownerId = req.query.ownerId ? Number(req.query.ownerId) : undefined;
    const counts = await job.getStatusCounts({ ownerId: Number.isFinite(ownerId) ? ownerId : undefined });
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

/*
 * Update — exposed as BOTH PUT and PATCH to the same handler. The CRM_UI
 * edit flow uses PATCH semantically (partial update) while some integration
 * callers use PUT; both land on the same validator + service call so we
 * don't fork behaviour.
 */
const updateHandler = async (req, res, next) => {
  try {
    const updated = await job.update(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job updated');
  } catch (e) { next(e); }
};
router.put('/:id',   validate(idParam, 'params'), validate(updateBody), updateHandler);
router.patch('/:id', validate(idParam, 'params'), validate(updateBody), updateHandler);

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
