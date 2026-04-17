const Joi = require('joi');

const intId = Joi.number().integer().positive();

const candidatesQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(50).default(10),
  ignoreDistance: Joi.boolean().default(false),
});

const bulkQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(500).default(50),
  dryRun: Joi.boolean().default(false),
});

const jobIdParam = Joi.object({ jobId: intId.required() });

module.exports = { candidatesQuery, bulkQuery, jobIdParam };
