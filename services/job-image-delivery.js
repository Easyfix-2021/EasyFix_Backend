/*
 * Resolve a stored tbl_job_image value into something a BROWSER can fetch.
 *
 * Extracted from routes/admin/jobs.js on 2026-09-10 so that two routes share
 * ONE definition of "where does this image actually live":
 *
 *   GET /admin/jobs/images/:imageId/file  → redirects or streams
 *   GET /admin/jobs/images/:imageId/url   → returns the URL as JSON
 *
 * The second exists so the CRM can stop putting the session JWT in the image
 * URL. An <img src> carries no Authorization header, so the file route accepts
 * `?token=<jwt>` — which puts a live session token into browser history, the
 * Referer header, and every proxy and access log in between. Fetching a JSON
 * url first (where the header works) and rendering a plain <img> at the
 * returned URL removes that entirely, and keeps <img>'s no-CORS behaviour:
 * a fetch() of an S3 presigned URL would need a bucket CORS policy that a
 * plain <img> does not.
 *
 * Kinds returned:
 *   { kind: 's3',       url }   presigned, short TTL, object confirmed present
 *   { kind: 'legacy',   url }   https URL on an ALLOWLISTED host, HEAD-verified
 *   { kind: 'local',    path }  a file on this host — caller must stream it
 *   { kind: 'base-url', url }   absolute FILE_BASE_URL (prod Nginx)
 *   { kind: 'none',     reason} nothing resolvable
 */
const fs = require('fs');
const path = require('path');
const s3Storage = require('../utils/s3-storage');

const LEGACY_HOSTS = () => (process.env.LEGACY_FILE_HOSTS || 'core.easyfix.in')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/*
 * Is there really an image at this legacy URL?
 *
 * A redirect that cannot fail is not a resolution. When the file is absent the
 * legacy host answers with a ~236-byte text/html error page; the CRM fetches
 * these as <img> no-cors subresources, so Chrome's Opaque Response Blocking
 * refuses the HTML and reports net::ERR_BLOCKED_BY_ORB with no status and zero
 * bytes — an opaque browser error where the operator should have seen our own
 * "Image not found" state.
 *
 * REFUSES ONLY ON POSITIVE EVIDENCE: a HEAD that times out or errors still
 * says "usable", so a transient fault cannot hide a file that is really there.
 */
async function legacyUrlHasImage(url) {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(Number(process.env.LEGACY_FILE_HEAD_TIMEOUT_MS || 2500)),
    });
    const ctype = String(head.headers.get('content-type') || '').toLowerCase();
    if (!head.ok || (ctype && !ctype.startsWith('image/') && !ctype.startsWith('application/pdf'))) {
      return { usable: false, why: `status ${head.status}, content-type ${ctype || 'none'}` };
    }
    return { usable: true, why: 'ok' };
  } catch (err) {
    return { usable: true, why: `unverified (${err && err.name ? err.name : 'error'})` };
  }
}

async function resolve(storedRaw, { logger } = {}) {
  const stored = String(storedRaw || '').trim();
  if (!stored) return { kind: 'none', reason: 'empty stored value' };

  // (1) S3 — the stored key, plus the two legacy prefixes older rows used.
  if (s3Storage.isEnabled()) {
    const candidates = [stored];
    if (!stored.startsWith('Job_Images/') && !stored.startsWith('JobSupportings/')) {
      candidates.push(`JobSupportings/${path.basename(stored)}`);
      candidates.push(`Job_Images/${path.basename(stored)}`);
    }
    for (const key of candidates) {
      try {
        if (await s3Storage.exists(key)) {
          return { kind: 's3', url: await s3Storage.getPresignedUrl(key) };
        }
      } catch (e) {
        if (logger) logger.warn({ key, err: e && e.message }, 's3 lookup failed — falling through to local');
        break;
      }
    }
  }

  // (2) Local disk — writeBuffer-fallback uploads and pre-S3 legacy files.
  const roots = [
    process.env.UPLOAD_JOB_FILES,
    process.env.UPLOAD_ROOT_PATH,
    './uploads/upload_jobs',
    './uploads',
  ].filter(Boolean);
  const relForms = [stored, path.basename(stored)];
  for (const root of roots) {
    const absRoot = path.resolve(root);
    for (const rel of relForms) {
      const candidate = path.resolve(absRoot, rel.replace(/^\/+/, ''));
      // Path-traversal guard: candidate MUST sit inside absRoot.
      if (!candidate.startsWith(absRoot + path.sep) && candidate !== absRoot) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { kind: 'local', path: candidate };
      }
    }
  }

  // (3) The stored value is ITSELF an absolute URL on a host we own.
  if (/^https?:\/\//i.test(stored)) {
    let parsed = null;
    try { parsed = new URL(stored); } catch { parsed = null; }
    if (parsed && LEGACY_HOSTS().includes(parsed.hostname.toLowerCase())) {
      // https-upgraded: rows store http://, the CRM is https, and a browser
      // blocks an http image on an https page. The host 301s anyway.
      parsed.protocol = 'https:';
      const verdict = await legacyUrlHasImage(parsed.toString());
      if (verdict.usable) return { kind: 'legacy', url: parsed.toString(), verdict: verdict.why };
      return { kind: 'none', reason: `legacy host has no image (${verdict.why})` };
    }
    // Host-allowlisted: this URL comes from a database column. Redirecting to
    // an arbitrary host would be an open redirect.
    return { kind: 'none', reason: `absolute URL on a non-allowlisted host${parsed ? ' ' + parsed.hostname : ''}` };
  }

  // (4) Absolute FILE_BASE_URL (prod Nginx). Never a relative base — that
  // would bounce back to this backend, which has no handler.
  const fileBase = process.env.FILE_BASE_URL || '';
  if (/^https?:\/\//i.test(fileBase)) {
    const base = fileBase.replace(/\/+$/, '');
    const url = stored.includes('/')
      ? `${base}/${stored.replace(/^\/+/, '')}`
      : `${base}/upload_jobs/${stored}`;
    return { kind: 'base-url', url };
  }

  return { kind: 'none', reason: 'not in S3, no local file, no absolute FILE_BASE_URL' };
}

module.exports = { resolve, legacyUrlHasImage, _LEGACY_HOSTS: LEGACY_HOSTS };
