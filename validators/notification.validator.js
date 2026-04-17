const Joi = require('joi');

const testBody = Joi.object({
  channel: Joi.string().valid('sms', 'email', 'whatsapp', 'fcm').required(),
  to: Joi.string().required(),
  // channel-specific payload:
  message: Joi.string().max(1000).when('channel', { is: 'sms', then: Joi.required() }),
  subject: Joi.string().max(200).when('channel', { is: 'email', then: Joi.required() }),
  body: Joi.string().max(5000).when('channel', { is: 'email', then: Joi.required() }),
  templateName: Joi.string().max(100).when('channel', { is: 'whatsapp', then: Joi.required() }),
  recipientName: Joi.string().max(200).optional(),
  bodyValues: Joi.object().pattern(Joi.string(), Joi.any()).default({}),
  title: Joi.string().max(200).when('channel', { is: 'fcm', then: Joi.required() }),
  pushBody: Joi.string().max(500).optional(),
  data: Joi.object().pattern(Joi.string(), Joi.any()).default({}),
});

module.exports = { testBody };
