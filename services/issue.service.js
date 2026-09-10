const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
const { getEffectivePermissions } = require('./role.service');

/*
 * ─── IN-APP ISSUE REPORTER ─────────────────────────────────────────────────
 *
 * Any CRM user can report a problem from the page they are on. An issue
 * manager triages the queue, comments, and closes with a note.
 *
 * Two tables (migrations/2026-09-10-crm-issue-reporter.sql) and one service,
 * called from routes/admin/issues.js. The route owns HTTP shape and nothing
 * else; every rule about who may see or change an issue lives here.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE OWNERSHIP RULE — STATED ONCE, ENFORCED ON THE ROW ACTUALLY FETCHED
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   READ an issue, or ADD A COMMENT to it, if
 *       issue.reported_by === actor.userId   OR   actor.canManage
 *   CLOSE it, or LIST with scope=all, only if
 *       actor.canManage
 *
 * `canManage` is "holds the isIssueManage action key", resolved by
 * resolveActor() below.
 *
 * ── WHY THE CHECK IS ON THE FETCHED ROW, NOT IN THE WHERE CLAUSE ─────────
 * The tempting shape is `WHERE id = ? AND (reported_by = ? OR <manager>)`,
 * which returns zero rows for an unauthorised caller and lets the handler
 * answer 404. It is one statement shorter and it is the wrong shape here,
 * twice over:
 *
 *   1. It makes "no such issue" and "not yours" the same result, so the guard
 *      has no way to say which happened and neither do the logs. A guard whose
 *      failure is indistinguishable from an empty table cannot be tested — the
 *      passing and failing cases return identical output.
 *   2. Every caller of a row-loading helper would have to remember to pass the
 *      predicate. The moment one does not, the query is a plain `WHERE id = ?`
 *      and it looks correct at the call site. Fetching first and asserting
 *      after puts the guard in ONE place that every path routes through, so a
 *      new endpoint cannot forget it: loadIssueForActor() is the only way to
 *      get an issue row out of this module.
 *
 * ── req.scope IS DELIBERATELY NOT CONSULTED ─────────────────────────────
 * /api/admin attaches a city/client-shaped `req.scope` to every request and
 * most services intersect it into their WHERE clause. This one does not, and
 * the omission is a decision rather than an oversight. An issue is INTERNAL:
 * it is about the CRM itself, not about a job, a client or a city. Filtering
 * the queue by the reporter's geography would hide "the Jobs list crashes on
 * page 2" from a manager in a different city, which is the precise opposite of
 * what a bug queue is for. There is no `req.scope` reference anywhere in this
 * file or in routes/admin/issues.js, and there should not be one.
 *
 * ── THE SCREENSHOT IS PRESIGNED IN EXACTLY ONE PLACE ────────────────────
 * getIssueDetail() mints a 900-second presigned GET URL, AFTER assertCanRead
 * has passed, and it is the only function in this module that calls
 * getPresignedUrl. The list deliberately cannot: listIssues() never selects
 * screenshot_key at all — it projects `screenshot_key IS NOT NULL AS
 * has_screenshot`, so the key does not exist in the result set to be leaked by
 * a later refactor that forgets to delete it. A presigned URL is a bearer
 * credential in a query string: anyone holding it can fetch the object for 15
 * minutes with no auth at all, so it must never be minted for a caller who has
 * not already passed the per-row check.
 */

/** The two values the frontend switches on. Nothing else is ever stored. */
const STATUS = { OPEN: 'open', CLOSED: 'closed' };

/** The single action key that means "issue manager". */
const MANAGE_ACTION = 'isIssueManage';

/** S3 prefix for screenshots. No extension on the key — MIME rides on
 *  Content-Type, per the ops convention in utils/s3-storage.js. */
const S3_PREFIX = 'Issues/';

/** Presigned-URL lifetime for a screenshot, seconds. Longer than the 5-minute
 *  default because the reader may be scrolling a long comment thread before
 *  the <img> is scrolled into view; far shorter than the 1-hour notice TTL
 *  because an issue screenshot can contain anything that was on the
 *  reporter's screen. */
const SCREENSHOT_PRESIGN_TTL_SEC = 900;

function badRequest(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/*
 * Resolve the caller into the { userId, canManage } shape every function here
 * takes. Reuses req.user.permissions when an upstream requireAction() has
 * already hydrated it (the close route), and otherwise asks role.service —
 * which is itself cached and single-flighted per user, so the read routes pay
 * at most one lookup per request.
 *
 * Kept in the service rather than the route so that "what counts as a manager"
 * is defined next to the rule that uses it; a route that resolved the key
 * itself could drift to a different key name and nothing would fail.
 */
async function resolveActor(req) {
  const userId = req.user && req.user.user_id;
  if (!userId) throw badRequest('authentication required', 401);
  if (!req.user.permissions) {
    req.user.permissions = await getEffectivePermissions(userId);
  }
  const perms = (req.user.permissions && req.user.permissions.actionPermissions) || [];
  return { userId: Number(userId), canManage: perms.includes(MANAGE_ACTION) };
}

/** The rule, in one place. Returns true / false; callers turn it into a 403. */
function canRead(issue, actor) {
  return actor.canManage || Number(issue.reported_by) === Number(actor.userId);
}

/*
 * Load an issue and assert the actor may READ it. The ONLY way an issue row
 * leaves this module — see the ownership note above for why this is a fetch-
 * then-assert and not a predicate in the WHERE clause.
 *
 * 404 when it does not exist, 403 when it exists and is not the actor's. Those
 * are different answers on purpose: an issue id is a small sequential integer,
 * so hiding existence behind a 404 buys nothing an attacker could not get by
 * counting, and it costs the reporter a comprehensible error.
 */
async function loadIssueForActor(issueId, actor) {
  const [rows] = await pool.query(
    'SELECT id, title, description, page_path, screenshot_key, status, reported_by, created_on, closed_by, closed_on, close_note FROM tbl_crm_issue WHERE id = ?',
    [issueId],
  );
  if (!rows.length) throw badRequest('Issue not found', 404);
  const issue = rows[0];
  if (!canRead(issue, actor)) {
    logger.warn('Issue access refused · issueId=' + issueId + ' userId=' + actor.userId);
    throw badRequest('You may only view issues you reported', 403);
  }
  return issue;
}

/*
 * Create an issue. `screenshotKey` is the S3 key the route stored, or null —
 * the route owns the upload because that is where multer put the buffer, and
 * this function owns the row.
 *
 * created_on is `new Date()`, never NOW(): the pool's +05:30 session timezone
 * (db.js) stores the IST wall clock verbatim, whereas NOW() would read the
 * container clock and mix two timezones into one column.
 */
async function createIssue({ title, description, pagePath, screenshotKey, userId }) {
  const [r] = await pool.query(
    'INSERT INTO tbl_crm_issue (title, description, page_path, screenshot_key, status, reported_by, created_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, description, pagePath || null, screenshotKey || null, STATUS.OPEN, userId, new Date()],
  );
  logger.info('Issue reported · id=' + r.insertId + ' by=' + userId + (screenshotKey ? ' withScreenshot' : ''));
  return { id: r.insertId };
}

/*
 * The queue. `scope=all` is a manager-only view; `scope=mine` is every
 * caller's own issues and needs no grant.
 *
 * has_screenshot is computed IN SQL rather than derived from a selected key —
 * see the presign note in the header. screenshot_key is not in this projection
 * and must never be added to it.
 */
async function listIssues({ scope, status, limit, offset }, actor) {
  if (scope === 'all' && !actor.canManage) {
    logger.warn('Issue list scope=all refused · userId=' + actor.userId);
    throw badRequest(`Missing permission: ${MANAGE_ACTION}`, 403);
  }

  const where = [];
  const params = [];
  if (scope !== 'all') {
    where.push('i.reported_by = ?');
    params.push(actor.userId);
  }
  if (status) {
    where.push('i.status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT i.id, i.title, i.page_path, i.status, i.reported_by, i.created_on, i.closed_on,
            (i.screenshot_key IS NOT NULL) AS has_screenshot,
            (SELECT COUNT(*) FROM tbl_crm_issue_comment c WHERE c.issue_id = i.id) AS comment_count
       FROM tbl_crm_issue i
       ${clause}
      ORDER BY i.id DESC
      LIMIT ?, ?`,
    [...params, offset, limit],
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_crm_issue i ${clause}`,
    params,
  );

  return {
    items: rows.map((r) => ({ ...r, has_screenshot: !!r.has_screenshot })),
    total: (countRows[0] && countRows[0].total) || 0,
    limit,
    offset,
  };
}

/*
 * Detail + comments. The ONE place a screenshot URL is minted, and only after
 * loadIssueForActor has passed.
 *
 * screenshot_url is null when there is no screenshot, when S3 is unconfigured
 * (local dev), and when signing fails — the frontend must treat null as
 * "nothing to show", not as an error. The raw key is not returned: a key is
 * useless to the browser and returning it only widens what a logged response
 * body exposes.
 */
async function getIssueDetail(issueId, actor) {
  const issue = await loadIssueForActor(issueId, actor);

  const [comments] = await pool.query(
    'SELECT id, comment_text, commented_by, created_on FROM tbl_crm_issue_comment WHERE issue_id = ? ORDER BY id ASC',
    [issueId],
  );

  let screenshotUrl = null;
  if (issue.screenshot_key && s3Storage.isEnabled()) {
    try {
      screenshotUrl = await s3Storage.getPresignedUrl(issue.screenshot_key, SCREENSHOT_PRESIGN_TTL_SEC);
    } catch (e) {
      // A signing failure must not take the whole issue down — the reporter
      // still needs to read the description and the thread.
      logger.warn('Issue screenshot presign failed · issueId=' + issueId + ' err=' + (e && e.message));
    }
  }

  const { screenshot_key: _key, ...rest } = issue;
  return {
    ...rest,
    has_screenshot: !!issue.screenshot_key,
    screenshot_url: screenshotUrl,
    comments,
  };
}

/*
 * Add a comment. Same read rule as the detail — a reporter can answer a
 * question on their own issue without holding the key, which is the whole
 * point of the thread.
 *
 * Deliberately allowed on a CLOSED issue: "this came back" belongs on the
 * original issue, not in a new one, and re-opening is not a state this
 * feature has.
 */
async function addComment(issueId, { commentText }, actor) {
  await loadIssueForActor(issueId, actor);
  const [r] = await pool.query(
    'INSERT INTO tbl_crm_issue_comment (issue_id, comment_text, commented_by, created_on) VALUES (?, ?, ?, ?)',
    [issueId, commentText, actor.userId, new Date()],
  );
  logger.info('Issue comment added · issueId=' + issueId + ' by=' + actor.userId);
  return { id: r.insertId };
}

/*
 * Close. Manager-only — the route mounts requireAction(isIssueManage), and
 * this re-asserts on the actor rather than trusting the mount, because the
 * guard and the rule must not be able to drift apart.
 *
 * 409 on an already-closed issue: two managers working the queue will
 * occasionally both close the same row, and the loser must be told the row
 * moved rather than silently overwriting the first closer's note and
 * timestamp.
 */
async function closeIssue(issueId, { closeNote }, actor) {
  if (!actor.canManage) throw badRequest(`Missing permission: ${MANAGE_ACTION}`, 403);

  const issue = await loadIssueForActor(issueId, actor);
  if (issue.status === STATUS.CLOSED) {
    throw badRequest('Issue is already closed', 409);
  }

  await pool.query(
    'UPDATE tbl_crm_issue SET status = ?, closed_by = ?, closed_on = ?, close_note = ? WHERE id = ? AND status = ?',
    [STATUS.CLOSED, actor.userId, new Date(), closeNote || null, issueId, STATUS.OPEN],
  );
  logger.info('Issue closed · id=' + issueId + ' by=' + actor.userId);
  return { id: issueId, status: STATUS.CLOSED };
}

/** Build the S3 key for a screenshot. Timestamp + 8 hex chars, no extension —
 *  the same shape buildNoticeKey / buildClientDocKey use. */
function buildScreenshotKey() {
  const crypto = require('crypto');
  return `${S3_PREFIX}${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  STATUS,
  MANAGE_ACTION,
  SCREENSHOT_PRESIGN_TTL_SEC,
  buildScreenshotKey,
  resolveActor,
  canRead,
  loadIssueForActor,
  createIssue,
  listIssues,
  getIssueDetail,
  addComment,
  closeIssue,
};
