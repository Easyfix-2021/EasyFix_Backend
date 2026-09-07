const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const logger = require('../logger');
const { todayIst } = require('./ist-calendar');

/*
 * A certificate renderer that knows NOTHING about EasyFix's domain.
 *
 *   renderCertificatePdf({ recipientName, title, eyebrow, heading, dateText,
 *                          certificateId, signatoryName, signatoryTitle, stream })
 *   await renderCertificateImage({ ...the same nine strings, format: 'png'|'jpg' })
 *
 * Required: recipientName, title, and (for the PDF) stream. Everything else has
 * a default or is omitted when absent.
 *
 * ─── ONE LAYOUT DECISION, TWO OUTPUTS ──────────────────────────────────────
 * planCertificate() is the ONLY thing that decides where a run goes and what
 * point size it survives at. Both renderers consume its output and neither may
 * measure, shrink or position anything itself. That is not tidiness: PDF and
 * image are the same document in two containers, and a second copy of the
 * fitting rule would disagree with the first the moment either was tweaked —
 * silently, because each output would still look correct on its own.
 *
 * The plan is computed at the TARGET canvas size, and every length in the
 * fitter (the point ceiling, the MIN_PT floor, the half-point step, the
 * tracking) scales with it. Fitting is linear in size, so a plan at 3508px
 * makes byte-for-byte the same decisions as one at 841.89pt, 4.17x larger.
 *
 * ─── WHY GENERIC ───────────────────────────────────────────────────────────
 * It used to take { technician, course, completedOn, score } and reach into
 * LMS-shaped objects. That made the ONE piece of artwork the company owns
 * usable by exactly one feature: a long-service award, a partner accreditation
 * or an operator-typed one-off each needed either a fake `course` object or a
 * second renderer that would immediately drift from this one's layout. Nine
 * strings in, one PDF out — the callers do the domain mapping (LMS's lives in
 * services/lms.service.js::certificatePayload).
 *
 * ─── WHY IT TAKES A STREAM ─────────────────────────────────────────────────
 * Unchanged, and the same contract as utils/pdf-invoice.js. routes/admin/
 * finance.js proves three delivery paths against that shape: pipe to `res` for
 * a download, to a buffer for an email attachment, into archiver for a ZIP. A
 * function returning a Buffer serves exactly one of those.
 *
 * ─── THE ARTWORK, AND WHY MISSING ART IS NOT AN ERROR ──────────────────────
 * The look comes from a Brand Kit background plus a sibling JSON naming where
 * each text run goes, both under assets/certificate/. pdfkit cannot read SVG,
 * so the PDF takes the 3508px raster; the image path prefers the vector frame
 * and falls back to that same raster, which is what keeps a PDF and a PNG
 * downloaded on the same day identical even when only one of the two frame
 * files has landed.
 *
 * If the background or the layout is missing or unreadable the renderer logs a
 * warning and draws the plain navy/gold border it always drew, using the same
 * region names from DEFAULT_LAYOUT. That is deliberate: the art and the code
 * ship on different clocks, and a download that 500s because a file has not
 * landed yet is worse than one that looks plain. There is exactly ONE placement
 * code path either way — the fallback is a different set of rectangles and a
 * few extra shapes in the plan, not a different renderer.
 *
 * ─── WHY EVERY RUN AUTO-SHRINKS ────────────────────────────────────────────
 * pdfkit flows text: a long name at a fixed size wraps and pushes everything
 * below it down a page that has no "below". Each run is measured against its
 * own rectangle and the point size steps down until it fits, with `ellipsis` as
 * the last backstop. So a 60-character name degrades predictably instead of
 * colliding with the line under it, and the layout is identical for everyone.
 *
 * ─── NOTHING IS PERSISTED ──────────────────────────────────────────────────
 * No certificate table, no stored file, no issued_on, no revoke. The document
 * is a pure projection of facts that already exist, so rendering it twice
 * produces the same certificate and there is no issuance event to duplicate.
 * `certificateId` is passed IN by the caller (LMS derives it from the already
 * unique easyfixer_courses.id) — this file never mints one.
 */

const ARTWORK_DIR = path.join(__dirname, '..', 'assets', 'certificate');
const ARTWORK_PNG = path.join(ARTWORK_DIR, 'easyfix-certificate-frame-3508.png');
const ARTWORK_SVG = path.join(ARTWORK_DIR, 'easyfix-certificate-frame.svg');
const ARTWORK_LAYOUT = path.join(ARTWORK_DIR, 'certificate-layout.json');

/* A4 landscape in points — the PDF page, and the unit every STYLE size is in. */
const PT_W = 841.89;
const PT_H = 595.28;

/* The raster canvas: A4 landscape at 300dpi, the artwork's native size. */
const PX_W = 3508;
const PX_H = 2480;

const NAVY = '#12305B';
const GOLD = '#B8912F';
const INK = '#1A1A1A';
const MUTED = '#5A5A5A';

const MIN_PT = 6;

const DEFAULT_HEADING = 'CERTIFICATE OF COMPLETION';
const DEFAULT_EYEBROW = 'FOR SUCCESSFULLY COMPLETING THE TRAINING';
const PRESENTED_TO = 'PRESENTED TO';
const DATE_LABEL = 'DATE';

/*
 * Fallback rectangles, normalised 0..1 exactly like the shipped layout file, so
 * the placement loop below cannot tell the two apart. Region names are the
 * contract with the Brand Kit artefact.
 */
const DEFAULT_LAYOUT = Object.freeze({
  heading:            { x: 0.10, y: 0.135, w: 0.80, h: 0.070 },
  eyebrowPresentedTo: { x: 0.20, y: 0.255, w: 0.60, h: 0.038 },
  recipientName:      { x: 0.08, y: 0.310, w: 0.84, h: 0.110 },
  eyebrowFor:         { x: 0.15, y: 0.450, w: 0.70, h: 0.040 },
  title:              { x: 0.10, y: 0.505, w: 0.80, h: 0.080 },
  dateValue:          { x: 0.12, y: 0.740, w: 0.26, h: 0.050 },
  dateLabel:          { x: 0.12, y: 0.810, w: 0.26, h: 0.032 },
  signatoryName:      { x: 0.62, y: 0.740, w: 0.26, h: 0.050 },
  signatoryTitle:     { x: 0.62, y: 0.810, w: 0.26, h: 0.032 },
  /*
   * 0.885, not 0.92. Measured: at 0.92 the id baseline lands ON the inner gold
   * rule the fallback draws at H-36, so a rendered certificate had the number
   * struck through by its own border. The rectangle has to clear that rule, not
   * merely sit inside the page.
   */
  certificateIdLine:  { x: 0.30, y: 0.885, w: 0.40, h: 0.028 },
});

/* Per-region typography. Sizes are a CEILING — fitting shrinks, never grows. */
const STYLE = Object.freeze({
  heading:            { font: 'Helvetica',      size: 15, color: MUTED, tracking: 3 },
  eyebrowPresentedTo: { font: 'Helvetica',      size: 11, color: MUTED, tracking: 2 },
  recipientName:      { font: 'Helvetica-Bold', size: 38, color: INK },
  eyebrowFor:         { font: 'Helvetica',      size: 11, color: MUTED, tracking: 1 },
  title:              { font: 'Helvetica-Bold', size: 22, color: NAVY },
  dateValue:          { font: 'Helvetica',      size: 12, color: INK },
  dateLabel:          { font: 'Helvetica',      size: 8,  color: MUTED, tracking: 2 },
  signatoryName:      { font: 'Helvetica-Bold', size: 12, color: INK },
  signatoryTitle:     { font: 'Helvetica',      size: 8,  color: MUTED, tracking: 2 },
  certificateIdLine:  { font: 'Helvetica',      size: 8,  color: MUTED, tracking: 1 },
});

/*
 * The wordmark the plain-border fallback prints where the frame's logo would
 * be. Deliberately NOT in DEFAULT_LAYOUT: that object is the contract with the
 * design pipeline (every key in it may be overridden by the layout file), and
 * this run exists only when there is no pipeline output to override it.
 */
const FALLBACK_MARK_RECT = Object.freeze({ x: 0.05, y: 0.085, w: 0.90, h: 0.055 });
const FALLBACK_MARK_STYLE = Object.freeze({ font: 'Helvetica-Bold', size: 26, color: NAVY });

/*
 * One rectangle, tolerantly. The layout file is authored by a design pipeline
 * rather than by this repo, so {x,y,w,h}, {x,y,width,height} and [x,y,w,h] are
 * all accepted; anything else is treated as absent and that ONE region falls
 * back rather than taking the whole document down.
 */
function toRect(v) {
  if (!v) return null;
  const a = Array.isArray(v)
    ? v
    : [v.x, v.y, v.w !== undefined ? v.w : v.width, v.h !== undefined ? v.h : v.height];
  const [x, y, w, h] = a.map(Number);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/*
 * Read the layout file into 0..1 rectangles.
 *
 * The `canvas` block is what makes pixel rectangles survivable: the contract
 * says normalised, but a generator that emits pixels produces numbers far
 * outside 0..1, and drawing those would put every line off the page with no
 * error anywhere. Dividing by the declared canvas is a strictly better failure
 * than a blank certificate, so it is done rather than detected.
 */
function readLayout(raw) {
  const src = raw.regions || raw.rects || raw;
  const canvas = raw.canvas || raw.size || {};
  const cw = Number(canvas.width) || Number(raw.width) || 0;
  const ch = Number(canvas.height) || Number(raw.height) || 0;

  const out = {};
  for (const name of Object.keys(DEFAULT_LAYOUT)) {
    const rect = toRect(src[name]);
    if (!rect) continue;
    const pixels = [rect.x, rect.y, rect.w, rect.h].some((n) => n > 1.5);
    if (pixels) {
      if (!(cw > 0 && ch > 0)) continue;
      out[name] = { x: rect.x / cw, y: rect.y / ch, w: rect.w / cw, h: rect.h / ch };
    } else {
      out[name] = rect;
    }
  }
  return { regions: out, canvasWidth: cw, canvasHeight: ch };
}

/*
 * Both artwork files or neither. `recipientName` and `title` are the two runs
 * whose position cannot be guessed from the rest, so a layout missing either is
 * treated as unusable and the whole render falls back — a half-placed document
 * on company letterhead is worse than a plain one.
 *
 * Read per render rather than cached: a certificate is a per-download event,
 * the JSON is a couple of KB, and a cache here would mean a redeployed frame
 * needs a container restart to appear.
 */
function loadArtwork(framePath) {
  const hasFrame = fs.existsSync(framePath);
  const hasLayout = fs.existsSync(ARTWORK_LAYOUT);
  if (!hasFrame || !hasLayout) {
    logger.warn('Certificate artwork missing · frame=' + hasFrame + ' · layout=' + hasLayout
      + ' · rendering the plain-border fallback (expected under ' + ARTWORK_DIR + ')');
    return null;
  }
  try {
    const parsed = readLayout(JSON.parse(fs.readFileSync(ARTWORK_LAYOUT, 'utf8')));
    if (!parsed.regions.recipientName || !parsed.regions.title) {
      logger.warn('Certificate layout has no recipientName/title rectangle · plain-border fallback');
      return null;
    }
    return { ...parsed, framePath };
  } catch (e) {
    logger.warn('Certificate layout unreadable · ' + e.message + ' · plain-border fallback');
    return null;
  }
}

/*
 * THE measuring device, for both outputs.
 *
 * pdfkit's AFM metrics decide every shrink step, and the image path uses the
 * same numbers rather than asking a rasteriser — otherwise the two would fit
 * text differently on any host whose font stack resolves Helvetica elsewhere.
 * A throwaway document per render would be pure allocation: nothing is ever
 * drawn on this one, planCertificate is synchronous, and Node is single
 * threaded, so no two plans can interleave on its font state.
 */
let measurer = null;
function measured(font, size) {
  if (!measurer) measurer = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  measurer.font(font).fontSize(size);
  return measurer;
}

/*
 * Place one run inside its rectangle, centred, shrinking to fit.
 *
 * Height first: a point size taller than the box can never fit, so it is capped
 * before a single width measurement. Then width, in half-point steps, down to
 * MIN_PT. What MIN_PT still cannot hold — an unbroken 200-character string — is
 * TRUNCATED here rather than left to pdfkit's `ellipsis`, because SVG has no
 * equivalent and a rule the two renderers cannot both obey is not a shared
 * rule. So the worst case is a truncated line, never a line that runs over the
 * one below it, in either format.
 *
 * Every length scales with the canvas, so this returns the same decision at
 * 841.89pt and at 3508px.
 */
function fitRun(name, text, rect, style, scale) {
  const minPt = MIN_PT * scale;
  const step = 0.5 * scale;
  const tracking = (style.tracking || 0) * scale;
  const opts = { characterSpacing: tracking };
  const widthAt = (s, str) => measured(style.font, s).widthOfString(str, opts);

  let size = Math.min(style.size * scale, rect.h / 1.25);
  while (size > minPt && widthAt(size, text) > rect.w) size = Math.max(minPt, size - step);

  /*
   * Only what MIN_PT still could not hold. The guard is not decoration: the
   * loop measures `out + '…'`, which is WIDER than `out`, so without it a run
   * that fits perfectly well gets a character shaved off and an ellipsis added
   * — measured, on a 66-character name that the shrink step had already made
   * fit. Both outputs truncated it identically, which is exactly why sharing
   * the rule is not the same as the rule being right.
   */
  let out = text;
  if (widthAt(size, out) > rect.w) {
    while (out.length > 1 && widthAt(size, out + '…') > rect.w) out = out.slice(0, -1);
    out += '…';
  }

  const doc = measured(style.font, size);
  const lineHeight = doc.currentLineHeight();
  const ascender = (doc._font && doc._font.ascender) || 718;
  const top = rect.y + Math.max(0, (rect.h - lineHeight) / 2);
  return {
    name,
    text: out,
    rect,
    size,
    tracking,
    font: style.font,
    color: style.color,
    top,
    baseline: top + (ascender / 1000) * size,
  };
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

/*
 * THE layout decision. Everything either renderer needs, and nothing either
 * renderer may decide for itself.
 *
 * `frames` is the ordered list of background files this output can actually
 * display — the PDF passes only the raster because pdfkit cannot read SVG, the
 * image path passes the vector first. The first one on disk wins; if none is,
 * the whole render falls back, which is why `framePath` comes back out on the
 * plan rather than being recomputed by the caller.
 */
function planCertificate(values, W, H, frames) {
  const scale = W / PT_W;
  const art = loadArtwork(frames.find((f) => fs.existsSync(f)) || frames[frames.length - 1]);
  const layout = art ? art.regions : {};
  const rect = (r) => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
  const regionRect = (name) => rect(layout[name] || DEFAULT_LAYOUT[name]);

  /*
   * `dateText` defaults to today in IST — deliberately IST and not the server's
   * clock, because the containers run UTC and a certificate issued at 09:00 IST
   * would otherwise be dated the previous day for four and a half hours every
   * night. Passing null or '' omits the date PAIR: never a "DATE" label with
   * nothing under it.
   */
  const date = values.dateText === undefined ? formatDate(todayIst()) : values.dateText;

  const wanted = [
    ['heading', values.heading || DEFAULT_HEADING],
    ['eyebrowPresentedTo', PRESENTED_TO],
    ['recipientName', values.recipientName],
    ['eyebrowFor', values.eyebrow || DEFAULT_EYEBROW],
    ['title', values.title],
    ['dateValue', date],
    ['dateLabel', date ? DATE_LABEL : ''],
    ['signatoryName', values.signatoryName],
    ['signatoryTitle', values.signatoryName ? values.signatoryTitle : ''],
    ['certificateIdLine', values.certificateId],
  ];

  const runs = [];
  if (!art) {
    runs.push(fitRun('brandMark', 'EasyFix', rect(FALLBACK_MARK_RECT), FALLBACK_MARK_STYLE, scale));
  }
  /*
   * The omission rule, in one place: an empty value draws nothing at all. That
   * is what keeps a certificate with no signatory from printing a bare rule
   * with "Training Head" floating under it, and a manual render with no id from
   * printing an empty caption.
   */
  for (const [name, value] of wanted) {
    if (isBlank(value)) continue;
    runs.push(fitRun(name, String(value).trim(), regionRect(name), STYLE[name], scale));
  }

  /*
   * The rules are part of the artwork when there IS artwork. Planned here only
   * for the fallback, and the underlines only under a block that actually has
   * content — a rule with nothing above it reads as a field somebody forgot.
   */
  const shapes = [];
  if (!art) {
    const under = (r) => ({
      kind: 'line', x1: r.x, y1: r.y + r.h + 4 * scale, x2: r.x + r.w, y2: r.y + r.h + 4 * scale,
      stroke: GOLD, lineWidth: 0.5 * scale,
    });
    shapes.push(
      { kind: 'rect', x: 24 * scale, y: 24 * scale, w: W - 48 * scale, h: H - 48 * scale, stroke: NAVY, lineWidth: 3 * scale },
      { kind: 'rect', x: 36 * scale, y: 36 * scale, w: W - 72 * scale, h: H - 72 * scale, stroke: GOLD, lineWidth: 1.5 * scale },
      { kind: 'line', x1: W / 2 - 60 * scale, y1: 0.225 * H, x2: W / 2 + 60 * scale, y2: 0.225 * H, stroke: GOLD, lineWidth: 1 * scale },
    );
    if (date) shapes.push(under(regionRect('dateValue')));
    if (values.signatoryName) shapes.push(under(regionRect('signatoryName')));
  }

  if (art && art.canvasWidth > 0 && art.canvasHeight > 0) {
    const drift = Math.abs((art.canvasWidth / art.canvasHeight) - (W / H));
    if (drift > 0.02) {
      logger.warn('Certificate frame aspect differs from the page by ' + drift.toFixed(3)
        + ' · the background will be stretched to fill it');
    }
  }

  return { art, runs, shapes, scale, width: W, height: H };
}

/*
 * ─── OUTPUT 1: the PDF ─────────────────────────────────────────────────────
 *
 * Takes a stream, same contract as utils/pdf-invoice.js: routes/admin/
 * finance.js proves three delivery paths against that shape — pipe to `res`,
 * to a buffer for an email attachment, into archiver for a ZIP. A function
 * returning a Buffer serves exactly one of those.
 */
function renderCertificatePdf({ stream, ...values }) {
  /* Landscape: a certificate is read as a wall document, not a report page. */
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  doc.pipe(stream);

  const W = doc.page.width;
  const H = doc.page.height;
  /* Raster only: pdfkit cannot read SVG, so the vector frame is not offered. */
  const plan = planCertificate(values, W, H, [ARTWORK_PNG]);

  if (plan.art) doc.image(plan.art.framePath, 0, 0, { width: W, height: H });

  for (const s of plan.shapes) {
    doc.lineWidth(s.lineWidth).strokeColor(s.stroke);
    if (s.kind === 'rect') doc.rect(s.x, s.y, s.w, s.h).stroke();
    else doc.moveTo(s.x1, s.y1).lineTo(s.x2, s.y2).stroke();
  }

  for (const r of plan.runs) {
    doc.font(r.font).fillColor(r.color).fontSize(r.size)
      .text(r.text, r.rect.x, r.top, {
        width: r.rect.w,
        height: r.rect.h,
        align: 'center',
        lineBreak: false,
        ellipsis: true,
        characterSpacing: r.tracking,
      });
  }

  doc.end();
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/*
 * The plan as SVG. Text only when there is a frame — the frame is composited
 * underneath by sharp, because nesting one SVG document inside another is a
 * feature rasterisers disagree about and a stretched <image> is not.
 *
 * The one correction this file makes for the rasteriser: SVG `letter-spacing`
 * adds its space AFTER every glyph including the last, while pdfkit's
 * characterSpacing only goes between them. Centre a tracked run and the SVG
 * therefore sits half a tracking unit to the right of the PDF's. Measured, not
 * assumed — at 300dpi the CERTIFICATE OF COMPLETION band landed 7px right of
 * the PDF's, exactly its 12.5px tracking halved, and the untracked runs did
 * not move. Subtracting it here puts every band back within a pixel.
 *
 * Helvetica first, then the two metric-compatible clones a Linux container
 * actually has. Arial and sans-serif are the last resorts: this is the one
 * place the two outputs can diverge, because the PDF embeds Helvetica's own
 * metrics and the raster gets whatever fontconfig resolves.
 */
const SVG_FONT_STACK = "Helvetica, 'Liberation Sans', 'Nimbus Sans', Arial, sans-serif";

function certificateSvg(plan) {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.width}" height="${plan.height}" `
    + `viewBox="0 0 ${plan.width} ${plan.height}">`,
  ];
  for (const s of plan.shapes) {
    parts.push(s.kind === 'rect'
      ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" `
        + `stroke="${s.stroke}" stroke-width="${s.lineWidth}"/>`
      : `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" `
        + `stroke="${s.stroke}" stroke-width="${s.lineWidth}"/>`);
  }
  for (const r of plan.runs) {
    const cx = r.rect.x + r.rect.w / 2 - r.tracking / 2;
    parts.push(`<text x="${cx}" y="${r.baseline}" fill="${r.color}" `
      + `font-family="${SVG_FONT_STACK}" font-size="${r.size}" `
      + `font-weight="${/Bold/.test(r.font) ? 'bold' : 'normal'}" `
      + `letter-spacing="${r.tracking}" text-anchor="middle" `
      + `xml:space="preserve">${xml(r.text)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/*
 * ─── OUTPUT 2: the raster ──────────────────────────────────────────────────
 *
 * Returns a Buffer rather than taking a stream: sharp is async and produces one
 * buffer at the end anyway, so a stream here would only be a Buffer wearing a
 * costume, and buffering is what lets a failure still become a JSON error
 * instead of a truncated image behind a 200.
 *
 * The vector frame is preferred and the 3508px raster is the fallback, so a
 * PNG and a PDF pulled on a day when only the raster has landed are still the
 * same document. `fit: 'fill'` matches what pdfkit does with an off-aspect
 * background — stretch, do not letterbox — so neither output crops the other's
 * margins away.
 */
async function renderCertificateImage({ format = 'png', ...values }) {
  const plan = planCertificate(values, PX_W, PX_H, [ARTWORK_SVG, ARTWORK_PNG]);
  const overlay = Buffer.from(certificateSvg(plan));

  /*
   * flatten() is on the BACKGROUND, and it is load-bearing rather than tidy:
   * sharp applies it before the composite whatever order it is called in, and
   * measured, a frame with a transparent ground encodes to BLACK in JPEG
   * without it — not white, and not an error. Whitening the ground first is
   * also what leaves the composited result opaque in PNG.
   */
  const base = (plan.art
    ? sharp(plan.art.framePath, { density: 300 }).resize(PX_W, PX_H, { fit: 'fill' })
    : sharp({ create: { width: PX_W, height: PX_H, channels: 3, background: '#FFFFFF' } })
  ).flatten({ background: '#FFFFFF' });

  const composed = base.composite([{ input: overlay, top: 0, left: 0 }]);
  return format === 'jpg'
    ? composed.jpeg({ quality: 95 }).toBuffer()
    : composed.png().toBuffer();
}

/*
 * 'YYYY-MM-DD…' → '30 August 2026'.
 *
 * The pool runs with dateStrings, so a DATETIME arrives as 'YYYY-MM-DD HH:mm:ss'
 * ALREADY in IST. Parsing that into a Date and formatting it locally is the
 * naive-parse shift that has bitten this codebase repeatedly, so the digits are
 * sliced out of the string and reformatted directly. Only a real Date takes the
 * other branch, and it is read in UTC because todayIst() produces a UTC-shifted
 * calendar date.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(v) {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) {
    const month = MONTHS[Number(m[2]) - 1];
    return month ? `${m[3]} ${month} ${m[1]}` : '—';
  }
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* The content types and filename extensions the two outputs are served under. */
const OUTPUT_FORMATS = Object.freeze({
  pdf: { contentType: 'application/pdf', ext: 'pdf' },
  png: { contentType: 'image/png', ext: 'png' },
  jpg: { contentType: 'image/jpeg', ext: 'jpg' },
});

module.exports = {
  renderCertificatePdf,
  renderCertificateImage,
  planCertificate,
  certificateSvg,
  formatDate,
  OUTPUT_FORMATS,
  ARTWORK_DIR,
  ARTWORK_PNG,
  ARTWORK_SVG,
  ARTWORK_LAYOUT,
  DEFAULT_LAYOUT,
  PX_W,
  PX_H,
};
