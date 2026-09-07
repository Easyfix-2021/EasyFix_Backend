const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const {
  renderCertificatePdf, renderCertificateImage, OUTPUT_FORMATS,
} = require('../../utils/pdf-certificate');
const logger = require('../../logger');

/*
 * Manual certificate rendering — /api/admin/certificates.
 *
 * ─── WHY THIS EXISTS SEPARATELY FROM THE LMS ───────────────────────────────
 *
 * The company owns ONE piece of certificate artwork, and the LMS is not the
 * only thing that ever needs to print on it: a long-service award, a partner
 * accreditation, a replacement for somebody whose training predates the LMS.
 * Before this route, each of those meant either faking an easyfixer_courses row
 * so the LMS download would fire, or a second renderer that would drift from
 * the first. Nine strings in, one PDF out, no row invented anywhere.
 *
 * ─── IT IS PURELY A RENDER ─────────────────────────────────────────────────
 *
 * Nothing is written. No certificate table, no stored file, no issued_on, no
 * revoke — the same decision the LMS certificate rides on. There is therefore
 * no issuance event to duplicate and no cleanup to own: this endpoint turns a
 * request body into bytes and forgets it.
 *
 * That also fixes the identifier question. `certificateId` is whatever the
 * caller types, or nothing at all — an operator-typed certificate has no
 * unique key to derive one from, and minting a serial would create exactly the
 * idempotency problem the stateless design avoids. When the id is absent the
 * line is omitted rather than printed empty.
 *
 * ─── THE GATE ──────────────────────────────────────────────────────────────
 *
 * isCertificateIssue, seeded by migrations/2026-09-07-hrms-certificates-menu.sql
 * alongside the HRMS → Certificates page this endpoint powers. It was
 * isLmsManage while the page was an LMS one; it is not any more, and a key that
 * ties an HRMS page to an LMS permission reads as a mistake in Manage Roles.
 * Issuing a document in somebody's name is its own privilege anyway — the
 * recipient need not exist in this database at all.
 *
 * Mounted under /api/admin, so requireAuth + role(['admin']) + the city scope
 * attach already ran. Scope does not apply here — there is no row to filter.
 */

const renderBody = Joi.object({
  recipientName: Joi.string().trim().max(120).required(),
  title: Joi.string().trim().max(160).required(),
  /*
   * Optional, and each one's ABSENCE is meaningful: the renderer omits a run
   * rather than drawing its label with nothing under it. `''` is allowed for
   * dateText specifically so a caller can suppress the date pair on a document
   * that should not carry one.
   */
  heading: Joi.string().trim().max(80).optional(),
  eyebrow: Joi.string().trim().max(120).optional(),
  dateText: Joi.string().trim().allow('').max(60).optional(),
  certificateId: Joi.string().trim().max(40).optional(),
  signatoryName: Joi.string().trim().max(80).optional(),
  signatoryTitle: Joi.string().trim().max(80).optional(),
  /*
   * PDF stays the default: it is what every existing caller and the LMS
   * download produce, and it is the one that prints. png/jpg exist because the
   * HRMS page also puts the certificate on a screen and into a chat message,
   * where a PDF attachment is a download nobody opens.
   */
  format: Joi.string().lowercase().valid(...Object.keys(OUTPUT_FORMATS)).default('pdf'),
});

/*
 * Streams the document itself, not modernOk() — the body IS the document.
 *
 * Content-Disposition so the browser saves it under a readable name, with the
 * extension matching what was actually produced; no-store because the document
 * carries a named individual and a copy sitting in a shared-machine cache is a
 * small privacy leak for no benefit.
 *
 * Validation runs BEFORE anything is written, which is what lets a bad body
 * still become a normal JSON 400. The headers are likewise set only once the
 * chosen renderer cannot fail any more: the image is awaited into a Buffer
 * first, so a sharp failure is still a JSON 500 rather than a truncated file
 * behind a 200 — and for the PDF, once piping starts the status line is
 * already sent, which is why nothing between here and doc.end() may throw.
 */
router.post('/render', requireAction('isCertificateIssue'), validate(renderBody),
  async (req, res, next) => {
    try {
      const { format, ...b } = req.body;
      const out = OUTPUT_FORMATS[format];
      logger.info('Manual certificate render · recipient=' + b.recipientName
        + ' · title=' + b.title + ' · format=' + format
        + ' · by=' + (req.user?.user_id ?? '?'));

      /*
       * `undefined` is what makes the renderer default to today in IST, so an
       * omitted dateText must NOT be normalised to '' anywhere on the way in —
       * that would mean "print no date at all", a different request. Spreading
       * the validated body is what preserves the distinction; naming each field
       * would turn every omission into an explicit undefined, which is the same
       * thing here but stops being so the moment a default is added above.
       */
      const image = out.ext === 'pdf' ? null : await renderCertificateImage({ ...b, format });

      const safeName = String(b.recipientName)
        .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'certificate';
      res.setHeader('Content-Type', out.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition',
        `attachment; filename="EasyFix-Certificate-${safeName}.${out.ext}"`);

      if (image) return res.end(image);
      renderCertificatePdf({ ...b, stream: res });
      return undefined;
    } catch (e) {
      return next(e);
    }
  });

module.exports = router;
