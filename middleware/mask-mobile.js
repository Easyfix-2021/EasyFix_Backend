/*
 * Mobile-number masking middleware for /api/admin/* responses.
 *
 * Wraps `res.json` so any payload heading to a CRM operator's browser
 * has its mobile-bearing fields (customer_mob_no, mobile_no, efr_no,
 * caller, reciever, …) replaced with first-4-digits-then-bullets BEFORE
 * Express serialises the response.
 *
 * Why middleware rather than per-route masking:
 *   - Single point of enforcement. New endpoints inherit masking
 *     automatically; we can't forget to add it on a fresh route.
 *   - The audit surface is one file instead of dozens.
 *
 * Edit-form escape hatch (?unmasked=true):
 *   Edit forms need to pre-fill the mobile input with the actual current
 *   number so the operator can verify + selectively edit. The masked
 *   string can't round-trip through a save without corrupting the
 *   record (Joi mobile pattern is digits-only).
 *
 *   The opt-out is a query param `?unmasked=true` on the request. The
 *   middleware short-circuits when present, returning the payload raw.
 *   Permission gating is the responsibility of the calling route — any
 *   admin who can hit a /:id endpoint already has read access; if
 *   tightening is needed later, gate at the route by checking
 *   `req.query.unmasked === 'true'` and rejecting based on a permission
 *   action.
 *
 * Not applied to:
 *   - /api/integration/v1/*  (external client contract; CLAUDE.md no-
 *                              client-change rule)
 *   - /api/webhook/*          (outbound integrations expect raw numbers)
 *   - File downloads (.xlsx)  (res.json is not called for those —
 *                              middleware is a no-op)
 */

const { maskMobileInResponse } = require('../utils/mask-mobile');

function maskMobileResponseMiddleware(req, res, next) {
  const wantsUnmasked = String(req.query?.unmasked).toLowerCase() === 'true';
  if (wantsUnmasked) {
    // Short-circuit: edit-form opt-out. The route's own auth + role
    // checks already gate this; no further permission check here.
    return next();
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(maskMobileInResponse(body));
  return next();
}

module.exports = maskMobileResponseMiddleware;
