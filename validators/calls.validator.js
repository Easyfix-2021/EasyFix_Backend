const Joi = require('joi');

const intId = Joi.number().integer().positive();

/*
 * Click-to-call request body.
 *
 * Critical design rule: NO mobile number keys are accepted. The FE must
 * supply only an identifier (jobId or customerId); the backend resolves
 * the actual customer number from tbl_job / tbl_customer. This closes the
 * "operator reads first 4 digits, infers / leaks unmasked" loophole — if
 * FE doesn't possess the unmasked number it can't accidentally send it.
 *
 * .xor('jobId', 'customerId') means EXACTLY ONE must be present. Both
 * supplied → 400; neither → 400.
 *
 * The `.fork()`-less default ({}) at top + .xor() means an empty body
 * fails with a clear "must specify one of jobId, customerId" message
 * rather than a generic "value not allowed" — better DX for ops.
 */
const clickToCallBody = Joi.object({
  jobId: intId,
  customerId: intId,
}).xor('jobId', 'customerId');

/*
 * Call-history list query (modal tab + future drill-downs).
 *
 * Dates accepted as YYYY-MM-DD or ISO; service layer normalises.
 * Pagination defaults match the rest of /api/admin/* (page=1, limit=20).
 */
const callListQuery = Joi.object({
  jobId: intId.optional(),
  customerId: intId.optional(),
  dateFrom: Joi.string().max(40).optional(),
  dateTo:   Joi.string().max(40).optional(),
  page:     Joi.number().integer().min(1).default(1),
  limit:    Joi.number().integer().min(1).max(200).default(20),
});

module.exports = { clickToCallBody, callListQuery };
