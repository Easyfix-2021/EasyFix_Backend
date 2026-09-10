/*
 * OWNERSHIP tests for the in-app issue reporter (services/issue.service.js).
 *
 * What is under test is the AUTHORISATION rule, not the SQL: a caller may read
 * an issue and comment on it if they reported it OR they hold isIssueManage;
 * only the key holder may close, or list with scope=all.
 *
 * The rule is enforced in the service on the row it actually fetched, so the
 * service is where it can be tested. Every case below calls the service
 * directly with an explicit actor — no HTTP, no requireAction, no permission
 * lookup — because routing an authorisation test through a mounted router
 * proves the router is wired and only incidentally proves the rule.
 *
 * No DB: the fake-pool seam answers the reads, so nothing is inserted
 * anywhere.
 *
 * ─── THE POSITIVE CONTROL, AND WHY IT IS NOT OPTIONAL ──────────────────────
 *
 * Every refusal here is an exception, and loadIssueForActor throws for TWO
 * reasons: 403 when the row exists and is not yours, 404 when there is no row.
 * A fake pool whose SELECT regex did not match returns `[]`, which is a 404 —
 * so a broken fixture makes every "is refused" test pass, for the wrong
 * reason, in the direction of the hypothesis.
 *
 * Two things close that hole and both are load-bearing:
 *   1. Each refusal asserts the STATUS is 403, never merely that it threw.
 *   2. `reporter reads own issue` runs the SAME fixture through the SAME
 *      loader and asserts the row comes back with its title. If the fixture
 *      ever stops matching, that test fails first and names the real problem.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const REPORTER = 41;   // the user who raised issue 7
const STRANGER = 88;   // another CRM user, holds no key
const MANAGER  = 99;   // holds isIssueManage

// Mutable per-test fixture the fake pool's routes read.
const scenario = { issueStatus: 'open', imageKeys: [] };

function issueRow() {
  return {
    id: 7,
    title: 'Jobs list crashes on page 2',
    description: 'Clicking page 2 shows a white screen.',
    page_path: '/jobs',
    status: scenario.issueStatus,
    reported_by: REPORTER,
    created_on: '2026-09-10 11:04:00',
    closed_by: null,
    closed_on: null,
    close_note: null,
  };
}

/*
 * Routes are ORDER-SENSITIVE — fake-pool takes the first regex that matches.
 * The count query and the list query both contain `FROM tbl_crm_issue i`, and
 * the list query contains `FROM tbl_crm_issue_comment` in its comment-count
 * subselect, so the narrow patterns must come first. Getting this order wrong
 * routes a list to the count fixture and the assertions still "pass" — which
 * is exactly the class of error the positive control above is for.
 */
const routes = [
  [/COUNT\(\*\) AS total FROM tbl_crm_issue i/, () => [{ total: 1 }]],
  /*
   * Pinned on comment_count, which ONLY the list query computes. It used to be
   * /FROM tbl_crm_issue i\s/, and once the DETAIL query gained a LEFT JOIN it
   * began with the same words — so detail matched this route first, received a
   * list-shaped row with no screenshot_key, and the failure surfaced as "the
   * detail response never carries the raw S3 key". A stub returning the WRONG
   * row reads exactly like the code being wrong.
   */
  [/comment_count[\s\S]*FROM tbl_crm_issue i\b/, () => [{
    id: 7,
    title: 'Jobs list crashes on page 2',
    page_path: '/jobs',
    status: scenario.issueStatus,
    reported_by: REPORTER,
    created_on: '2026-09-10 11:04:00',
    closed_on: null,
    screenshot_count: 2,     // MySQL returns the COUNT as a number
    comment_count: 2,
  }]],
  /*
   * Matched on the TABLE + the id predicate, not on the column list or on
   * FROM sitting immediately before WHERE. The detail query gained
   * `LEFT JOIN tbl_user` for reporter/closer names, which pushed WHERE away
   * from FROM and broke the old pattern — the fixture then returned nothing
   * and the service 404'd, which reads as a logic bug rather than a stale
   * fixture. Pin what cannot change without the query MEANING something else.
   */
  [/FROM tbl_crm_issue i\b[\s\S]*WHERE i\.id = \?/, () => [issueRow()]],
  [/FROM tbl_crm_issue_comment c\b[\s\S]*WHERE c\.issue_id = \?/, () => [
    { id: 1, comment_text: 'Looking at it.', commented_by: MANAGER, created_on: '2026-09-10 11:30:00' },
  ]],
  /*
   * Pinned on `SELECT issue_id, s3_key` AND the table. The LIST query also
   * names tbl_crm_issue_image — in its `(SELECT COUNT(*) …)` screenshot_count
   * subselect — so a route pinned on the table alone would swallow the list and
   * hand it an image-shaped row. Same class of error as the comment_count note
   * above, and the same fix: pin what cannot change without the query MEANING
   * something else.
   */
  [/SELECT issue_id, s3_key[\s\S]*FROM tbl_crm_issue_image/, () =>
    scenario.imageKeys.map((k) => ({ issue_id: 7, s3_key: k }))],
  [/INSERT INTO tbl_crm_issue_image/, () => ({ insertId: 900, affectedRows: scenario.imageKeys.length })],
  [/INSERT INTO tbl_crm_issue_comment/, () => ({ insertId: 501 })],
  [/UPDATE tbl_crm_issue SET status/, () => ({ affectedRows: 1 })],
  [/INSERT INTO tbl_crm_issue /, () => ({ insertId: 7 })],
];

let fake;
let svc;

before(() => {
  // Install BEFORE requiring the service — it captures `pool` at require time.
  fake = installFakePool(routes);
  svc = require('../services/issue.service');
});

after(() => fake.restore());

beforeEach(() => {
  scenario.issueStatus = 'open';
  scenario.screenshotKey = null;
  fake.reset();
});

/*
 * The row-returning list query, as actually issued.
 *
 * The discriminator is `COUNT(*) AS total`, which only the outer count query
 * has — NOT a bare /COUNT/, because the list query carries its own COUNT(*) in
 * the comment-count subselect and a bare match excludes both queries, leaving
 * this helper returning undefined. It did exactly that on the first run; the
 * `assert.ok(listSql, …)` at each call site is what turned a silently-skipped
 * assertion into a failure that named itself.
 */
function listQueryCall() {
  return fake.calls.find((c) => /FROM tbl_crm_issue i\s/.test(c.sql) && !/COUNT\(\*\) AS total/.test(c.sql));
}

/** Assert `fn` rejects with exactly `status`, and report what it actually did. */
async function assertRejectsWithStatus(fn, status, label) {
  let caught = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `${label}: expected a rejection, got a successful return`);
  assert.equal(
    caught.status,
    status,
    `${label}: expected status ${status}, got ${caught.status} (${caught.message})`,
  );
  return caught;
}

// ─── POSITIVE CONTROL ────────────────────────────────────────────────────
// A read CAN succeed. If the fixture stops matching the SELECT, this fails
// first and every refusal below is exposed as a possible false pass.
test('positive control · reporter reads own issue and the fixture really matched', async () => {
  const issue = await svc.getIssueDetail(7, { userId: REPORTER, canManage: false });
  assert.equal(issue.id, 7);
  assert.equal(issue.title, 'Jobs list crashes on page 2');
  assert.equal(issue.reported_by, REPORTER);
  assert.equal(issue.comments.length, 1);
});

// ─── READ ────────────────────────────────────────────────────────────────
test('non-owner without the key is refused (403, not 404 — the row exists)', async () => {
  await assertRejectsWithStatus(
    () => svc.getIssueDetail(7, { userId: STRANGER, canManage: false }),
    403,
    'stranger reading someone else\'s issue',
  );
});

test('manager with the key reads an issue they did not report', async () => {
  const issue = await svc.getIssueDetail(7, { userId: MANAGER, canManage: true });
  assert.equal(issue.id, 7);
  assert.equal(issue.reported_by, REPORTER);
  assert.notEqual(issue.reported_by, MANAGER);
});

test('the detail response never carries a raw S3 key', async () => {
  scenario.imageKeys = ['Issues/1757500000000_a4b9c0d2', 'Issues/1757500000001_ff31aa02'];
  const issue = await svc.getIssueDetail(7, { userId: REPORTER, canManage: false });
  assert.equal(issue.screenshot_key, undefined);
  assert.equal(issue.screenshot_count, 2);
  assert.equal(issue.has_screenshot, true);
  // S3 is unconfigured in tests, so nothing is minted and an EMPTY ARRAY — not
  // null, and not a list of nulls — is the contract.
  assert.deepEqual(issue.screenshot_urls, []);
  // The keys themselves must not ride out on any field.
  assert.ok(
    !JSON.stringify(issue).includes('Issues/1757500000000_a4b9c0d2'),
    'no S3 key may appear anywhere in the detail response',
  );
});

test('an issue with no screenshots reports zero, not null', async () => {
  scenario.imageKeys = [];
  const issue = await svc.getIssueDetail(7, { userId: REPORTER, canManage: false });
  assert.equal(issue.screenshot_count, 0);
  assert.equal(issue.has_screenshot, false);
  assert.deepEqual(issue.screenshot_urls, []);
});

// ─── COMMENT ─────────────────────────────────────────────────────────────
test('reporter may comment on their own issue without the key', async () => {
  const r = await svc.addComment(7, { commentText: 'Still happening.' }, { userId: REPORTER, canManage: false });
  assert.equal(r.id, 501);
});

test('non-owner without the key may not comment', async () => {
  await assertRejectsWithStatus(
    () => svc.addComment(7, { commentText: 'me too' }, { userId: STRANGER, canManage: false }),
    403,
    'stranger commenting',
  );
  // And nothing was written on the way to the refusal.
  assert.equal(fake.calls.filter((c) => /INSERT INTO tbl_crm_issue_comment/.test(c.sql)).length, 0);
});

// ─── LIST ────────────────────────────────────────────────────────────────
test('list with scope=all requires the key', async () => {
  await assertRejectsWithStatus(
    () => svc.listIssues({ scope: 'all', limit: 50, offset: 0 }, { userId: STRANGER, canManage: false }),
    403,
    'stranger listing scope=all',
  );
});

test('list with scope=all is allowed for a key holder', async () => {
  const page = await svc.listIssues({ scope: 'all', limit: 50, offset: 0 }, { userId: MANAGER, canManage: true });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 1);
  // scope=all must NOT filter by reporter.
  const listSql = listQueryCall();
  assert.ok(listSql, 'expected a list query to have been issued');
  assert.ok(!/reported_by = \?/.test(listSql.sql), 'scope=all must not filter by reporter');
});

test('scope=mine filters by the caller and needs no key', async () => {
  const page = await svc.listIssues({ scope: 'mine', limit: 50, offset: 0 }, { userId: REPORTER, canManage: false });
  assert.equal(page.items.length, 1);
  const listSql = listQueryCall();
  assert.ok(/reported_by = \?/.test(listSql.sql), 'scope=mine must filter by reporter');
  assert.equal(listSql.params[0], REPORTER);
});

test('the LIST never returns a screenshot key or URL — only a count', async () => {
  const page = await svc.listIssues({ scope: 'mine', limit: 50, offset: 0 }, { userId: REPORTER, canManage: false });
  const row = page.items[0];
  assert.equal(row.screenshot_key, undefined);
  assert.equal(row.screenshot_url, undefined);
  assert.equal(row.screenshot_urls, undefined);
  assert.equal(row.screenshot_count, 2);
  assert.equal(row.has_screenshot, true, 'derived from the count, as a boolean');
  /*
   * Structural, not incidental: no key may be in the projection at all. The
   * list may NAME tbl_crm_issue_image — it counts rows in it — but it must
   * never select s3_key, because a key in the result set is one refactor away
   * from a key in the response.
   */
  const listSql = listQueryCall();
  assert.ok(!/s3_key/.test(listSql.sql), 'list must not select s3_key');
  assert.ok(!/screenshot_key/.test(listSql.sql), 'list must not select the frozen legacy column');
});

// ─── CLOSE ───────────────────────────────────────────────────────────────
test('close requires the key', async () => {
  await assertRejectsWithStatus(
    () => svc.closeIssue(7, { closeNote: 'fixed' }, { userId: REPORTER, canManage: false }),
    403,
    'reporter closing their own issue',
  );
  assert.equal(fake.calls.filter((c) => /UPDATE tbl_crm_issue SET status/.test(c.sql)).length, 0);
});

test('a key holder can close an open issue', async () => {
  const r = await svc.closeIssue(7, { closeNote: 'Deployed a fix.' }, { userId: MANAGER, canManage: true });
  assert.equal(r.status, 'closed');
  const upd = fake.calls.find((c) => /UPDATE tbl_crm_issue SET status/.test(c.sql));
  assert.ok(upd, 'expected the UPDATE to have been issued');
  assert.equal(upd.params[1], MANAGER, 'closed_by must be the closer');
  assert.ok(upd.params[2] instanceof Date, 'closed_on must be a JS Date (IST verbatim), never NOW()');
});

test('double close returns 409', async () => {
  scenario.issueStatus = 'closed';
  await assertRejectsWithStatus(
    () => svc.closeIssue(7, { closeNote: 'again' }, { userId: MANAGER, canManage: true }),
    409,
    'closing an already-closed issue',
  );
  assert.equal(fake.calls.filter((c) => /UPDATE tbl_crm_issue SET status/.test(c.sql)).length, 0);
});

// ─── CREATE ──────────────────────────────────────────────────────────────
test('create writes created_on as a JS Date, never NOW()', async () => {
  await svc.createIssue({
    title: 'x', description: 'y', pagePath: '/jobs', screenshotKeys: [], userId: REPORTER,
  });
  const ins = fake.calls.find((c) => /INSERT INTO tbl_crm_issue /.test(c.sql));
  assert.ok(ins, 'expected the INSERT to have been issued');
  assert.ok(!/NOW\(\)/.test(ins.sql), 'created_on must not be NOW() — the pool TZ stores IST verbatim');
  /*
   * The index is DERIVED from the statement's own column list, not written as
   * a literal. It used to be params[6]; dropping screenshot_key from the
   * INSERT moved created_on to 5 and the assertion began reading a different
   * column while still describing this one. A position is not the invariant —
   * "the value bound to created_on" is.
   */
  const cols = ins.sql.match(/\(([^)]*)\)\s*VALUES/)[1].split(',').map((c) => c.trim());
  const idx = cols.indexOf('created_on');
  assert.ok(idx >= 0, 'created_on must be in the INSERT column list');
  assert.ok(ins.params[idx] instanceof Date, 'created_on must be a JS Date');
});

test('N screenshots become N image rows, in the order attached, in ONE statement', async () => {
  fake.calls.length = 0;
  const keys = ['Issues/aaa', 'Issues/bbb', 'Issues/ccc'];
  await svc.createIssue({
    title: 'x', description: 'y', pagePath: '/jobs', screenshotKeys: keys, userId: REPORTER,
  });
  const imgIns = fake.calls.filter((c) => /INSERT INTO tbl_crm_issue_image/.test(c.sql));
  assert.equal(imgIns.length, 1, 'one multi-row INSERT, not one per screenshot');
  const rows = imgIns[0].params[0];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r[1]), keys, 'keys keep the order they were attached in');
  assert.deepEqual(rows.map((r) => r[2]), [0, 1, 2], 'sort_order is the attach order');
  assert.ok(rows.every((r) => r[0] === 7), 'every row points at the new issue');
  assert.ok(rows.every((r) => r[3] instanceof Date), 'created_on is a JS Date here too');
  // The frozen legacy column must not be written any more.
  const parentIns = fake.calls.find((c) => /INSERT INTO tbl_crm_issue /.test(c.sql));
  assert.ok(!/screenshot_key/.test(parentIns.sql), 'screenshot_key is frozen and must not be written');
});

test('no screenshots issues NO image INSERT at all', async () => {
  fake.calls.length = 0;
  await svc.createIssue({
    title: 'x', description: 'y', pagePath: '/jobs', screenshotKeys: [], userId: REPORTER,
  });
  assert.equal(fake.calls.filter((c) => /INSERT INTO tbl_crm_issue_image/.test(c.sql)).length, 0);
});
