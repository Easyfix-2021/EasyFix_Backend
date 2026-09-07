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

test('the two KPI chips stay global — deliberate legacy parity, pinned so it is a CHOICE', () => {
  /*
   * Open Escalation and Unconfirmed have never respected ANY dimension filter,
   * not client and not the three that predate it. That is copied from the
   * legacy repository and documented at the call site.
   *
   * Pinned here for two reasons: so nobody "fixes" it by accident while adding
   * a filter, and so that if ops ever asks why the chips ignore the filter bar,
   * the answer is a decision with a citation rather than a mystery.
   */
  return service.grid(ADMIN, { clientId: [7], cityId: [3] }, { pageNo: 1, pageSize: 10 })
    .then(() => {
      const kpis = fake.calls.filter(isKpiQuery);
      assert.equal(kpis.length, 2, 'the escalated and unconfirmed counts');
      for (const q of kpis) {
        assert.doesNotMatch(q.sql, /fk_client_id|fk_service_catg_id|TCY\.city_id IN/,
          'these are owner-scoped only by design (JobRepository.java:889-899); '
          + 'changing that is a product decision, not a filter fix');
      }
    });
});

test('the city drill-down and the export carry it too', async () => {
  fake.reset();
  await service.cityJobs(ADMIN, { clientId: [7], cityId: [3] });
  for (const q of jobQueries()) assert.match(q.sql, /TJ\.fk_client_id IN \(/, 'drill-down');

  fake.reset();
  await service.copyData(ADMIN, { clientId: [7] });
  const ex = jobQueries();
  assert.ok(ex.length >= 1, 'the export must run a job query');
  for (const q of ex) {
    assert.match(q.sql, /TJ\.fk_client_id IN \(/,
      'the export is the artefact that gets emailed — an unfiltered one is the '
      + 'most expensive version of this bug');
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
