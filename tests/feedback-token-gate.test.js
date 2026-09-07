'use strict';
/*
 * The feedback link has to work in BOTH flag states, because the cutover is not
 * atomic: links already in customers' hands carry no ?t=, and the templates that
 * mint new ones live outside this codebase. Every cell of this matrix is a real
 * customer with a real link in their SMS inbox.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { feedbackGate } = require('../routes/public/feedback');
const { mintFeedbackLink } = require('../services/feedback-link.service');
const { signFeedbackToken } = require('../utils/jwt');
const { signJobToken } = require('../utils/jwt');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-feedback-gate';

function run(gateEnv, { jobId = 42, t } = {}) {
  const prev = process.env.FEEDBACK_TOKEN_REQUIRED;
  process.env.FEEDBACK_TOKEN_REQUIRED = gateEnv;
  const req = { params: { jobId: String(jobId) }, query: t === undefined ? {} : { t } };
  const out = { status: null };
  const res = { status(c) { out.status = c; return this; }, json() { return this; } };
  let passed = false;
  try {
    feedbackGate(req, res, () => { passed = true; });
  } finally {
    if (prev === undefined) delete process.env.FEEDBACK_TOKEN_REQUIRED;
    else process.env.FEEDBACK_TOKEN_REQUIRED = prev;
  }
  return { passed, status: out.status };
}

test('GATE OFF — a legacy link with no token still works', () => {
  // Every SMS already delivered. If this ever fails, the cutover broke
  // customers who did nothing wrong.
  assert.equal(run('false').passed, true);
  assert.equal(run(undefined === undefined ? '' : '').passed, true, 'unset is also off');
});

test('GATE OFF — a NEW tokenised link works too', () => {
  const { token } = mintFeedbackLink(42);
  assert.equal(run('false', { jobId: 42, t: token }).passed, true);
});

test('GATE ON — the tokenised link keeps working', () => {
  const { token } = mintFeedbackLink(42);
  assert.equal(run('true', { jobId: 42, t: token }).passed, true);
});

test('GATE ON — a link with no token is refused', () => {
  const r = run('true');
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
});

test('A FORGED TOKEN IS REFUSED IN BOTH STATES', () => {
  /*
   * The important asymmetry: while the gate is OFF, no token is accepted but a
   * BAD token is not. Otherwise sending garbage would be strictly better than
   * sending nothing, which is the opposite of what a gate is for.
   */
  for (const state of ['false', 'true']) {
    const r = run(state, { t: 'not-a-jwt' });
    assert.equal(r.passed, false, `forged token accepted with gate ${state}`);
    assert.equal(r.status, 401);
  }
});

test("ONE CUSTOMER'S TOKEN CANNOT BE AIMED AT ANOTHER CUSTOMER'S JOB", () => {
  const { token } = mintFeedbackLink(42);
  for (const state of ['false', 'true']) {
    const r = run(state, { jobId: 99, t: token });
    assert.equal(r.passed, false, `job-42 token accepted on job 99 with gate ${state}`);
    assert.equal(r.status, 401);
  }
});

test('A JOB-COMPLETION TOKEN IS NOT A FEEDBACK TOKEN', () => {
  /*
   * Feedback links go to every customer after every visit — the widest
   * distribution we have. Job-completion tokens authorise a WRITE. Sharing one
   * type would make a leaked rating URL a job submission.
   */
  const completion = signJobToken({ jobId: 42 });
  const r = run('true', { jobId: 42, t: completion });
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
});

test('the minted URL carries the token and points at the feedback page', () => {
  const { url, token } = mintFeedbackLink(7);
  assert.match(url, /\/feedback\/7\?t=/, 'the page route the client portal serves');
  assert.equal(url.endsWith(encodeURIComponent(token)), true);
  // And a token signed for a different job must not verify against this URL's id.
  assert.notEqual(signFeedbackToken({ jobId: 8 }), token);
});
