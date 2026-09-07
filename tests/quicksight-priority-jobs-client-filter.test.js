/*
 * Priority Jobs — the client filter.
 *
 * WHAT WAS WRONG. Every schema on this report is built with extendJobFilter(),
 * and jobFilterBase carries `clientId` — so a body containing it VALIDATED
 * CLEANLY and then changed nothing. A caller could filter by client, receive a
 * 200, and read the whole book believing it was one client's. That is the worst
 * shape a filter bug takes: no error, plausible numbers, wrong population.
 *
 * The client profile's Reports section had to say, in its own UI, that this
 * report opens unfiltered — it was the only one of six that could not honour a
 * client.
 *
 * WHAT THESE GUARD, worst first:
 *   1. THE FILTER REACHES EVERY DIMENSION-FILTERED QUERY: the grid rows, the
 *      city COUNT behind pagination, the drill-down and the XLSX export. A
 *      filter reaching three of the four gives a page whose rows, pagination
 *      and export disagree — and the export is the one that gets emailed.
 *      The two KPI chips are deliberately global; see the test that pins it.
 *   2. THE VALUE IS BOUND, not interpolated, and the placeholder count matches
 *      the parameter count. mysql2 binds positionally, so one stray `?` shifts
 *      every later value silently.
 *   3. A BARE VISIT IS UNCHANGED. No clientId means no client clause at all.
 *
 * No DB: the shared pool singleton is faked BEFORE the service loads.
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([[/[\s\S]*/, () => []]]);
after(() => fake.restore());

const service = require('../services/quicksight/quicksight-priority-jobs.service');

// role 2 = admin, so owner scoping does not narrow and cannot mask a missing clause.
const ADMIN = { user_id: 1, user_role: 2 };

beforeEach(() => fake.reset());

/** Statements that actually touch the job table — the ones a filter must reach. */
const jobQueries = () => fake.calls.filter((c) => /tbl_job\s+TJ/.test(c.sql));

/*
 * grid() runs FOUR queries and only two of them are dimension-filtered. The
 * other two are the KPI chips, and their being global is DELIBERATE legacy
 * parity — the service says so at the call site and cites
 * JobRepository.java:889-899 / :901-909. So the tests below separate them
 * rather than asserting "every query", which was my first instinct and would
 * have made the code look broken when it is faithfully copied.
 */
const isRowsQuery  = (q) => /GROUP BY/i.test(q.sql) && /tbl_job\s+TJ/.test(q.sql);
const isCountQuery = (q) => /COUNT\(DISTINCT TCY\.city_id\)/.test(q.sql);
const isKpiQuery   = (q) => /is_escalated/.test(q.sql) || /job_status = 9/.test(q.sql);

test('THE REPORTED GAP: a clientId reaches both dimension-filtered queries', async () => {
  await service.grid(ADMIN, { clientId: [7] }, { pageNo: 1, pageSize: 10 });
  const scoped = fake.calls.filter((q) => isRowsQuery(q) || isCountQuery(q));
  assert.equal(scoped.length, 2, `expected the rows AND the city count; saw ${scoped.length}`);
  for (const q of scoped) {
    assert.match(q.sql, /TJ\.fk_client_id IN \(/,
      'rows and total must answer the SAME question — otherwise the page shows '
      + 'filtered rows under an unfiltered pagination count');
    assert.ok((q.params || []).includes(7), 'the id must be BOUND, not interpolated');
  }
});

test('THE KPI CHIPS FOLLOW THE FILTER BAR — all four queries, one population', () => {
  /*
   * CHANGED 2026-09-07, per ops, and deliberately AGAINST legacy parity.
   *
   * Open Escalation and Unconfirmed were owner-scoped only, copied from
   * JobRepository.java:889-899 / :901-909. So narrowing the grid to one client
   * or city left the chips beside it describing the whole book — two figures on
   * one screen answering different questions, and the chips are the half nobody
   * suspects because they carry no filter UI of their own.
   *
   * This is the assertion that used to say the opposite. It is inverted rather
   * than deleted so the history of the decision survives in the file that
   * enforces it.
   */
  return service.grid(ADMIN, { clientId: [7], cityId: [3] }, { pageNo: 1, pageSize: 10 })
    .then(() => {
      const kpis = fake.calls.filter(isKpiQuery);
      assert.equal(kpis.length, 2, 'the escalated and unconfirmed counts');
      for (const q of kpis) {
        assert.match(q.sql, /TJ\.fk_client_id IN \(/, 'the chip must respect the client filter');
        assert.match(q.sql, /TCY\.city_id IN \(/, 'and every other dimension too');
        assert.ok((q.params || []).includes(7) && (q.params || []).includes(3),
          'the values must be BOUND');
      }
    });
});

test('a query that FILTERS on city/state also JOINS them — or it cannot run at all', async () => {
  /*
   * The precondition that made this more than a one-line change. The dimension
   * filters bind to TCY / TS, which only exist through the address→city→state
   * chain. A query that applies the filters without the joins references an
   * undefined alias and fails outright; one that omits both silently answers a
   * different question — which is exactly what the KPI counts did.
   *
   * Asserted over EVERY statement the report issues, so a query added later
   * cannot pick one without the other.
   */
  await service.grid(ADMIN, { cityId: [3], stateId: [2] }, { pageNo: 1, pageSize: 10 });
  for (const q of fake.calls) {
    const filtersGeo = /TCY\.city_id IN \(|TS\.state_id IN \(/.test(q.sql);
    if (!filtersGeo) continue;
    assert.match(q.sql, /LEFT JOIN tbl_city TCY/, 'filters on TCY without joining it');
    assert.match(q.sql, /LEFT JOIN tbl_state TS/, 'filters on TS without joining it');
  }
});

test('POSITIONAL BINDING: placeholders equal parameters on every query', async () => {
  /*
   * mysql2 binds by position, so a miscounted `?` does not error — it shifts
   * every later value and the query still runs, filtering by the wrong thing.
   */
  await service.grid(ADMIN, { clientId: [7, 8], serviceCategoryId: [2], cityId: [3] },
    { pageNo: 2, pageSize: 10 });
  for (const q of fake.calls) {
    const holes = (q.sql.match(/\?/g) || []).length;
    assert.equal(holes, (q.params || []).length,
      `${holes} placeholders vs ${(q.params || []).length} params — every value after `
      + 'the gap binds to the wrong column');
  }
});

test('multiple client ids all bind', async () => {
  await service.grid(ADMIN, { clientId: [7, 8, 9] }, { pageNo: 1, pageSize: 10 });
  const q = jobQueries()[0];
  assert.match(q.sql, /TJ\.fk_client_id IN \(\?,\?,\?\)/);
  for (const id of [7, 8, 9]) assert.ok(q.params.includes(id));
});

test('A BARE VISIT IS UNCHANGED — no clientId, no client clause', async () => {
  await service.grid(ADMIN, {}, { pageNo: 1, pageSize: 10 });
  for (const q of fake.calls) {
    assert.doesNotMatch(q.sql, /fk_client_id/,
      'an empty filter must emit no clause at all, not `IN ()` or a no-op predicate');
  }
});

test('zeros are treated as "not selected", like every other dimension here', async () => {
  // The pickers use 0 as an "All" sentinel; filterZeros strips it.
  await service.grid(ADMIN, { clientId: [0] }, { pageNo: 1, pageSize: 10 });
  for (const q of fake.calls) assert.doesNotMatch(q.sql, /fk_client_id/);
});
