const router = require('express').Router();

const validate = require('../../middleware/validate');
const webhook = require('../../services/webhook.service');
const { modernOk, modernError } = require('../../utils/response');
const {
  idParam, eventCreateBody, eventUpdateBody, eventsQuery,
  mappingListQuery, mappingCreateBody, mappingUpdateBody,
  manualDispatchBody, logsQuery,
} = require('../../validators/webhook.validator');

// ─── Events registry ────────────────────────────────────────────────
router.get('/events', validate(eventsQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await webhook.listEvents(req.query)); } catch (e) { next(e); }
});

router.post('/events', validate(eventCreateBody), async (req, res, next) => {
  try {
    const created = await webhook.createEvent(req.body, req.user);
    res.status(201);
    modernOk(res, created, 'event created');
  } catch (e) { next(e); }
});

router.patch('/events/:id', validate(idParam, 'params'), validate(eventUpdateBody), async (req, res, next) => {
  try {
    const updated = await webhook.updateEvent(req.params.id, req.body, req.user);
    if (!updated) return modernError(res, 404, 'event not found');
    modernOk(res, updated, 'event updated');
  } catch (e) { next(e); }
});

// ─── Mappings registry ──────────────────────────────────────────────
router.get('/mappings', validate(mappingListQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await webhook.listMappings(req.query)); } catch (e) { next(e); }
});

router.post('/mappings', validate(mappingCreateBody), async (req, res, next) => {
  try {
    const ev = await webhook.listEvents({ includeInactive: true });
    if (!ev.some((e) => e.id === req.body.eventId)) {
      return modernError(res, 400, `eventId ${req.body.eventId} does not exist`);
    }
    const created = await webhook.createMapping(req.body);
    res.status(201);
    modernOk(res, created, 'mapping created');
  } catch (e) { next(e); }
});

router.patch('/mappings/:id', validate(idParam, 'params'), validate(mappingUpdateBody), async (req, res, next) => {
  try {
    const updated = await webhook.updateMapping(req.params.id, req.body);
    if (!updated) return modernError(res, 404, 'mapping not found');
    modernOk(res, updated, 'mapping updated');
  } catch (e) { next(e); }
});

router.delete('/mappings/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await webhook.deleteMapping(req.params.id);
    modernOk(res, { deleted: true }, 'mapping deactivated');
  } catch (e) { next(e); }
});

// ─── Manual dispatch + logs ─────────────────────────────────────────
router.post('/dispatch', validate(manualDispatchBody), async (req, res, next) => {
  try {
    const r = await webhook.manualDispatch(req.body);
    modernOk(res, r, 'manual dispatch queued');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/logs', validate(logsQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await webhook.listLogs(req.query)); } catch (e) { next(e); }
});

// ─── Preview the enriched payload without dispatching ───────────────
router.get('/preview/:jobId', async (req, res, next) => {
  try {
    const jobId = Number(req.params.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) return modernError(res, 400, 'invalid jobId');
    const payload = await webhook.buildJobPayload(jobId);
    if (!payload) return modernError(res, 404, 'job not found');
    delete payload._fk_client_id;
    modernOk(res, payload);
  } catch (e) { next(e); }
});

module.exports = router;
