const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const logger = require('../../logger');
const jobService = require('../../services/job.service');
const svc = require('../../services/job-permission-request.service');
const { modernOk, modernError } = require('../../utils/response');

/*
 * /api/mobile/jobs/:jobId/permission-requests — the TECHNICIAN half of the
 * site-access permission loop. He is at a mall gate / society office and cannot
 * get in; he raises a request, the client uploads the pass, he carries on.
 *
 * Mounted in routes/mobile/index.js as `router.use('/jobs', ...)`, which means
 * everything upstream already applies and nothing is repeated here:
 *   requireTechAuth                     → req.tech is populated
 *   requireTechJobMutationCapability    → the POST is a write on already-
 *                                         assigned work, so it needs the
 *                                         `mutateAssignedJobs` capability; the
 *                                         GET is a safe method and stays open
 *                                         to a restricted technician
 *   idempotency middleware              → an Idempotency-Key'd retry from the
 *                                         offline outbox replays the stored
 *                                         response instead of re-POSTing
 *
 * The two-segment path cannot collide with the `GET /jobs/:id` param route in
 * routes/mobile/index.js — that one matches exactly one segment after /jobs.
 *
 * AUTHORISATION: the job must be ASSIGNED to the caller. Not "offered to" —
 * unlike GET /jobs/:id, which lets an offered technician read a job to decide
 * whether to accept it, nobody is standing at a gate for a job they have not
 * taken. 404 on a miss, never 403: a distinguishable "exists but is not yours"
 * confirms which job ids exist. Same rule and same status as /share-link.
 */

const jobParam = Joi.object({ jobId: Joi.number().integer().positive().required() });

/** Load the job iff it is assigned to the calling technician; else answer 404. */
async function loadOwnJob(req, res, what) {
  const job = await jobService.getById(Number(req.params.jobId));
  if (!job || job.fk_easyfixter_id !== req.tech.efr_id) {
    logger.warn(what + ' · job not assigned to caller · job=' + req.params.jobId + ' · efr=' + req.tech.efr_id);
    modernError(res, 404, 'job not found');
    return null;
  }
  return job;
}

// ─── Raise a request ─────────────────────────────────────────────────
router.post(
  '/:jobId/permission-requests',
  validate(jobParam, 'params'),
  validate(Joi.object({
    kind: Joi.string().trim().min(2).max(120).required(),
    note: Joi.string().trim().max(500).allow('', null).optional(),
  })),
  async (req, res, next) => {
    try {
      const job = await loadOwnJob(req, res, 'Raise permission request');
      if (!job) return;

      const { row, created } = await svc.create({
        jobId: job.job_id,
        efrId: req.tech.efr_id,
        kind: req.body.kind,
        note: req.body.note,
      });

      /*
       * Notify only on a REAL create. A double-tap returns the existing request
       * and must not email the client a second time — the whole point of the
       * idempotency rule is that the client sees one ask, not two.
       *
       * Fire-and-forget: awaiting an SMTP round trip would make a technician
       * standing at a gate on a bad connection wait for it, and a mail failure
       * must never fail the request that is already durably stored.
       */
      if (created) {
        svc.notifyClientOfRequest({ job, row, techName: req.tech.efr_name })
          .catch((e) => logger.warn('Permission request notify threw · ' + e.message));
      }

      res.status(201);
      return modernOk(
        res,
        await svc.toItem(row),
        created ? undefined : 'an open request for this kind already exists',
      );
    } catch (e) { return next(e); }
  },
);

// ─── List this job's requests ────────────────────────────────────────
router.get(
  '/:jobId/permission-requests',
  validate(jobParam, 'params'),
  async (req, res, next) => {
    try {
      const job = await loadOwnJob(req, res, 'List permission requests');
      if (!job) return;
      const items = await svc.listForJob(job.job_id);
      logger.info('Permission requests listed (tech) · job=' + job.job_id + ' · n=' + items.length);
      return modernOk(res, { items });
    } catch (e) { return next(e); }
  },
);

module.exports = router;
