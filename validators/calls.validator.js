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
  // Four supported receiver-identifier shapes — the BE looks up the
  // actual mobile from the appropriate table and never trusts a
  // FE-supplied mobile string:
  //   jobId               → tbl_job.customer_mob_no (customer of a job)
  //   customerId          → tbl_customer.customer_mob_no
  //   efrId               → tbl_easyfixer.efr_no (technician)
  //   reportingContactId  → tbl_client_contacts.contact_no (client SPOC)
  jobId:              intId,
  customerId:         intId,
  efrId:              intId,
  reportingContactId: intId,
  // QA-MODE ONLY — when KALEYRA_CALLING_CUSTOM_NUMBER=true the FE prompts
  // the operator for both legs and forwards them here. The route handler
  // rejects these fields when the flag is OFF, so even though Joi accepts
  // the shape, defence-in-depth prevents privilege escalation in dev/prod.
  // Pattern matches the rest of the codebase: 10-12 digit Indian numbers.
  callFrom: Joi.string().pattern(/^[0-9]{10,12}$/),
  callTo:   Joi.string().pattern(/^[0-9]{10,12}$/),
}).xor('jobId', 'customerId', 'efrId', 'reportingContactId');

/*
 * Call-history list query (modal tab + future drill-downs).
 *
 * Dates accepted as YYYY-MM-DD or ISO; service layer normalises.
 * Pagination defaults match the rest of /api/admin/* (page=1, limit=20).
 */
const callListQuery = Joi.object({
  jobId: intId.optional(),
  customerId: intId.optional(),
  // /preview also accepts efrId / reportingContactId for tech + SPOC
  // call resolution. The /list endpoint ignores them (history is
  // anchored to job/customer); /preview branches on whichever is set.
  efrId: intId.optional(),
  reportingContactId: intId.optional(),
  dateFrom: Joi.string().max(40).optional(),
  dateTo:   Joi.string().max(40).optional(),
  page:     Joi.number().integer().min(1).default(1),
  limit:    Joi.number().integer().min(1).max(200).default(20),
});

module.exports = { clickToCallBody, callListQuery };
