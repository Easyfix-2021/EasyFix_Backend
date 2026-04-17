const router = require('express').Router();
const inbox = require('../../services/notification-inbox.service');
const { modernOk } = require('../../utils/response');

// Mounted inside routes/admin/notifications.js — these are the INBOX endpoints
// (in-app dashboard notifications), distinct from the outbound /test endpoint.

router.get('/inbox', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    const [items, unread] = await Promise.all([
      inbox.listByUser(req.user.user_id, { limit, offset }),
      inbox.countUnread(req.user.user_id),
    ]);
    modernOk(res, { items, unread });
  } catch (e) { next(e); }
});

router.get('/inbox/count', async (req, res, next) => {
  try { modernOk(res, { unread: await inbox.countUnread(req.user.user_id) }); } catch (e) { next(e); }
});

router.get('/inbox/job/:jobId', async (req, res, next) => {
  try { modernOk(res, await inbox.listByJob(Number(req.params.jobId))); } catch (e) { next(e); }
});

router.patch('/inbox/:id/read', async (req, res, next) => {
  try { await inbox.markRead(Number(req.params.id)); modernOk(res, { read: true }); } catch (e) { next(e); }
});

router.patch('/inbox/read-all', async (req, res, next) => {
  try { await inbox.markAllRead(req.user.user_id); modernOk(res, { allRead: true }); } catch (e) { next(e); }
});

router.get('/templates', async (req, res, next) => {
  try { modernOk(res, await inbox.templates()); } catch (e) { next(e); }
});

module.exports = router;
