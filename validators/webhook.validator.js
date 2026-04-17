const Joi = require('joi');

const intId = Joi.number().integer().positive();
const statusEnum = Joi.string().valid('active', 'inactive');

const idParam = Joi.object({ id: intId.required() });

const eventCreateBody = Joi.object({
  name: Joi.string().min(2).max(100).pattern(/^[A-Za-z][A-Za-z0-9_]*$/).required(),
  desc: Joi.string().max(500).optional(),
});

const eventUpdateBody = Joi.object({
  desc: Joi.string().max(500).optional(),
  status: statusEnum.optional(),
}).min(1);

const mappingListQuery = Joi.object({
  clientId: intId.optional(),
  eventId: intId.optional(),
  includeInactive: Joi.boolean().default(false),
});

const mappingCreateBody = Joi.object({
  clientId: intId.required(),
  eventId: intId.required(),
  callBackUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(1000).required(),
  authorization: Joi.string().max(500).optional().allow(null, ''),
});

const mappingUpdateBody = Joi.object({
  callBackUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(1000).optional(),
  authorization: Joi.string().max(500).optional().allow(null, ''),
  status: statusEnum.optional(),
}).min(1);

const manualDispatchBody = Joi.object({
  eventName: Joi.string().min(2).max(100).required(),
  jobId: intId.required(),
  mappingId: intId.required(),
});

const logsQuery = Joi.object({
  clientId: intId.optional(),
  eventId: intId.optional(),
  jobId: intId.optional(),
  limit: Joi.number().integer().min(1).max(500).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

const eventsQuery = Joi.object({ includeInactive: Joi.boolean().default(false) });

module.exports = {
  idParam, eventCreateBody, eventUpdateBody, eventsQuery,
  mappingListQuery, mappingCreateBody, mappingUpdateBody,
  manualDispatchBody, logsQuery,
};
