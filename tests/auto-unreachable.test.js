'use strict';
/*
 * The auto-unreachable sweep. Two things here can be quietly wrong and both
 * would be invisible in a passing deploy: the meaning of the predicate, and the
 * ORDER of the positional parameters.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../services/auto-unreachable.service');

/*
 * Every test here hands in a FAKE pool and needs no database — but the service
 * pulls in job-comment.service, which opens the real pool the moment it is
 * required. Closing it is what lets this file exit; without it the run hangs
 * forever with all tests green, which looks identical to a hang with them red.
 * Same `after` hook as tests/mobile-dashboard-today.test.js.
 */
const { pool } = require('../db');
test.after(async () => { await pool.end(); });

test('THE PREDICATE MEANS WHAT THE LABEL SAYS: no answered-call status counts', () => {
  /*
   * The bug this pins is not hypothetical. A proposal to base this rule on the
   * call log scored a 14x coverage gain by excluding only OUR leg's failures —
   * which let ANSWERED calls count as evidence of unreachability. 26.5% of the
   * jobs it would have surfaced had three or more days on which the customer
   * picked up. Telling a client their customer was unreachable on a day that
   * customer spoke to us is worse than saying nothing at all.
   */
  const spellings = svc.FAILED_CUSTOMER_LEG.map((s) => s.toLowerCase());
  for (const answered of ['answer', 'answered', 'answer_leg1', 'answer_leg2', 'ivr-answer', 'completed']) {
    assert.equal(spellings.includes(answered), false,
      `"${answered}" means the customer PICKED UP — it can never be evidence of unreachability`);
  }
  /*
   * "answer" appears inside the NEGATIVE spellings too — noanswer, no_answer,
   * NOANSWER_LEG2 — so the negation has to allow an optional separator. The
   * first version of this assertion did not, and flagged `no_answer`: the test
   * was wrong, not the list. Kept as a regex rather than a substring so the
   * distinction is visible instead of implied.
   */
  const isAffirmativeAnswer = (v) => /answer/.test(v) && !/no[_-]?answer/.test(v);
  const wrong = spellings.filter(isAffirmativeAnswer);
  assert.deepEqual(wrong, [],
    'a status meaning the customer PICKED UP can never be evidence of unreachability');
});

test('both provider vocabularies are covered, and only failure spellings', () => {
  // caller_status carries an UPPERCASE _LEG2 vocabulary from one provider and a
  // lowercase one from another. Covering only one silently halves the rule.
  assert.ok(svc.FAILED_CUSTOMER_LEG.includes('NOANSWER_LEG2'), 'uppercase _LEG2 vocabulary');
  assert.ok(svc.FAILED_CUSTOMER_LEG.includes('no_answer'), 'lowercase vocabulary');
  // LEG1 is OUR side. A failure there says nothing about the customer.
  assert.equal(svc.FAILED_CUSTOMER_LEG.some((s) => /_LEG1$/i.test(s)), false,
    'a LEG1 failure is our own leg failing — not evidence the customer was unreachable');
});

test('the rule is three days, and a terminal job is never marked', () => {
  assert.equal(svc.MIN_DAYS, 3);
  for (const closed of [3, 5, 6, 7]) {
    assert.ok(svc.TERMINAL_STATUSES.includes(closed),
      `status ${closed} is closed — a finished job is not waiting on anybody`);
  }
});

test('POSITIONAL BINDING: the SQL placeholders match the parameters exactly', async () => {
  /*
   * mysql2 binds positionally, so one miscounted `?` shifts every later value
   * without any error — the query still runs and quietly filters by the wrong
   * thing. Counting them is the only way to see it.
   */
  let captured = null;
  const fakePool = {
    query: async (sql, params) => {
      if (/FROM action_taken_reason/.test(sql)) return [[{ id: 4242 }]];
      captured = { sql, params };
      return [[]];
    },
  };
  svc._resetCache();
  await svc.findQualifying(fakePool, { minDays: 3, limit: 500 });
  assert.ok(captured, 'the qualifying query must have run');

  const placeholders = (captured.sql.match(/\?/g) || []).length;
  assert.equal(placeholders, captured.params.length,
    `${placeholders} placeholders vs ${captured.params.length} params — every value after the gap is bound to the wrong column`);

  // And the values must be in the order the SQL reads them.
  const expected = [...svc.FAILED_CUSTOMER_LEG, ...svc.TERMINAL_STATUSES, 4242, 3, 500];
  assert.deepEqual(captured.params, expected);
});

test('the idempotency guard keys on the reason ROW, not on comment text', async () => {
  /*
   * Text gets edited, translated and truncated; an FK does not. If the guard
   * ever keyed on wording, an edit would make the sweep re-mark every job it
   * had already marked, on every run, forever.
   */
  const sql = svc.qualifyingSql();
  assert.match(sql, /NOT EXISTS/, 'there must be a re-marking guard at all');
  assert.match(sql, /c\.enum_reason_id = \?/, 'and it must key on the reason id');
  assert.doesNotMatch(sql, /c\.comments\s+(LIKE|=)/i, 'never on the comment text');
});

test('an unseeded host does nothing rather than writing an unrecognisable marker', async () => {
  const fakePool = { query: async () => [[]] };   // no reason row
  svc._resetCache();
  const { reasonId, rows } = await svc.findQualifying(fakePool);
  assert.equal(reasonId, null);
  assert.deepEqual(rows, [], 'no candidates, so nothing can be written');

  svc._resetCache();
  const res = await svc.sweep(fakePool);
  assert.deepEqual(res, { marked: 0, skipped: 0, eligible: 0, seeded: false });
});

test('a dry run reports what it would do and writes nothing', async () => {
  const fakePool = {
    query: async (sql) => (/FROM action_taken_reason/.test(sql)
      ? [[{ id: 7 }]]
      : [[{ job_id: 1, failed_days: 4 }, { job_id: 2, failed_days: 3 }]]),
  };
  svc._resetCache();
  const res = await svc.sweep(fakePool, { dryRun: true });
  assert.equal(res.eligible, 2);
  assert.equal(res.marked, 0, 'a dry run must never write');
});
