const router = require('express').Router();

// In-app inbox sub-routes (list, mark-read, count, templates)
router.use(require('./notifications-inbox'));

const validate = require('../../middleware/validate');
const sms = require('../../services/sms.service');
const email = require('../../services/email.service');
const whatsapp = require('../../services/whatsapp.service');
const fcm = require('../../services/fcm.service');
const { modernOk, modernError } = require('../../utils/response');
const { testBody } = require('../../validators/notification.validator');

/*
 * POST /api/admin/notifications/test
 * Admin-only probe for each outbound channel. Respects NOTIFICATIONS_DISABLE —
 * in dev the response will include { disabled: true } without hitting providers.
 *
 * Bodies:
 *   { channel: "sms",      to: "9812345678", message: "…" }
 *   { channel: "email",    to: "x@y.com",   subject: "…", body: "…" }
 *   { channel: "whatsapp", to: "9812345678", templateName: "…", recipientName: "…", bodyValues: {…} }
 *   { channel: "fcm",      to: "<fcm-token>", title: "…", pushBody: "…", data: {…} }
 */
router.post('/test', validate(testBody), async (req, res, next) => {
  try {
    const { channel, to } = req.body;
    let result;
    switch (channel) {
      case 'sms':
        result = await sms.send({ to, message: req.body.message });
        break;
      case 'email':
        result = await email.send({
          to, subject: req.body.subject, text: req.body.body,
        });
        break;
      case 'whatsapp':
        result = await whatsapp.sendTemplate({
          to,
          recipientName: req.body.recipientName,
          templateName: req.body.templateName,
          bodyValues: req.body.bodyValues,
        });
        break;
      case 'fcm':
        result = await fcm.sendPush({
          token: to,
          title: req.body.title,
          body: req.body.pushBody,
          data: req.body.data,
        });
        break;
      default:
        return modernError(res, 400, `unknown channel "${channel}"`);
    }
    modernOk(res, { channel, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
