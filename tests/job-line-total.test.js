'use strict';
/*
 * ONE definition of what a job's services are worth.
 *
 * WHAT THIS REPLACED (2026-09-09)
 *
 * `total_charge × quantity + material_charge` was written out by hand in seven
 * places across two repos, in THREE variants, and the surfaces that used them
 * disagreed about the same job:
 *
 *   estimate preview / email / client approval   charge × qty + material
 *   invoice lines                                charge × qty + material
 *   invoice header (SQL)                         charge × qty            ← under-billed
 *   client services_subtotal                     charge × qty            ← named for services,
 *                                                                          dropped their material
 *   CRM JobTransactionView "Job Total"           charge                  ← no qty, no material
 *
 * The invoice header was live under-billing and is fixed in
 * tests/invoice-header-total.test.js. This file guards the thing that stops it
 * recurring: that there is now one owner, in both SQL and JS, and that the two
 * agree.
 *
 * WHY TWO EXPRESSIONS AT ALL. Some callers aggregate across many jobs in one
 * statement — an invoice covers a date range — where a per-job round trip would
 * be N+1. So the module exports a SQL fragment AND a JS function. That is a
 * compromise, and the point of the fixture below is that it is a CHECKED one.
 *
 * Runner: `node --test --test-force-exit tests/job-line-total.test.js`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LINE_TOTAL_SQL, ACTIVE_SERVICES_SQL, lineTotal, serviceCharge,
} = require('../services/job-line-total');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/*
 * MySQL semantics, modelled explicitly. Plain JS coerces NULL to 0 and would
 * make a broken SQL expression look correct — that exact confusion cost a
 * verification pass on the invoice fix, where the naive patch modelled as right
 * in JS and was three times worse than the bug in the database.
 */
const N = null;
const mul = (a, b) => (a === N || b === N ? N : a * b);
const add = (a, b) => (a === N || b === N ? N : a + b);

/** Evaluate the exported SQL fragment against a row, under MySQL NULL rules. */
function evalSql(row) {
  const sql = LINE_TOTAL_SQL('js');
  const co = (col, dflt) => (row[col] === N || row[col] === undefined ? dflt : row[col]);
  // Parsed from the fragment rather than restated, so a change to the exported
  // string that this file does not understand fails here instead of silently
  // testing a formula the module no longer uses.
  assert.match(sql, /COALESCE\(js\.total_charge, 0\)/);
  assert.match(sql, /COALESCE\(js\.quantity, 1\)/);
  assert.match(sql, /COALESCE\(js\.material_charge, 0\)/);
  return add(mul(co('total_charge', 0), co('quantity', 1)), co('material_charge', 0));
}

/* Every NULL shape a live row takes, plus the qty case the FE variant dropped. */
const ROWS = [
  { total_charge: 100, quantity: 3, material_charge: 50 },
  { total_charge: 200, quantity: 1, material_charge: N },
  { total_charge: N, quantity: 2, material_charge: 25 },
  { total_charge: 80, quantity: N, material_charge: N },
  { total_charge: 0, quantity: 5, material_charge: 0 },
];

test('the SQL fragment and the JS function agree on every row', () => {
  for (const row of ROWS) {
    assert.equal(
      lineTotal(row), evalSql(row),
      `SQL and JS disagree on ${JSON.stringify(row)} — two expressions of one rule must not drift`,
    );
  }
});

test('quantity is applied, and a missing quantity means one — not zero', () => {
  /*
   * The CRM's Job Transaction view summed total_charge with no quantity at all,
   * so a qty-3 line counted once. COALESCE(quantity, 1) is why a NULL quantity
   * bills the unit price rather than nothing.
   */
  assert.equal(lineTotal({ total_charge: 100, quantity: 3, material_charge: 0 }), 300);
  assert.equal(lineTotal({ total_charge: 80, quantity: N, material_charge: N }), 80);
  assert.match(LINE_TOTAL_SQL('js'), /COALESCE\(js\.quantity, 1\)/, 'and the SQL must default it the same way');
});

test('service_charge_subtotal is labour only, and the parts add back to the total', () => {
  for (const row of ROWS) {
    const material = Number(row.material_charge || 0);
    assert.equal(
      serviceCharge(row) + material, lineTotal(row),
      'service_charge_subtotal + material_subtotal must equal grand_total, or the client sees a breakdown that does not sum',
    );
  }
});

test('the alias is honoured, so a caller can join under any name', () => {
  assert.match(LINE_TOTAL_SQL('x'), /x\.total_charge/);
  assert.match(ACTIVE_SERVICES_SQL('x'), /x\.job_service_status/);
  assert.ok(!LINE_TOTAL_SQL('x').includes('js.'), 'no hardcoded alias may leak through');
});

test('the active-rows predicate survives a NULL status', () => {
  /*
   * `NULL <> 0` is NULL, i.e. false — so a bare `<> 0` silently DROPS any row
   * whose status was never set. The IS NULL arm is load-bearing, not decoration.
   */
  const p = ACTIVE_SERVICES_SQL('js');
  assert.match(p, /js\.job_service_status IS NULL/, 'an unset status must still count as active');
  assert.match(p, /js\.job_service_status <> 0/, 'and 0 must still mean soft-deleted');
});

// ── The callers ──────────────────────────────────────────────────────

test('every estimate/invoice surface reads the helper, none recomputes', () => {
  const callers = [
    ['estimate preview + email', 'routes/admin/jobs.js'],
    ['client approval payload', 'routes/client/index.js'],
    ['invoice lines + header', 'routes/admin/finance.js'],
  ];
  for (const [what, file] of callers) {
    const src = code(read(file));
    assert.match(src, /require\('\.\.\/\.\.\/services\/job-line-total'\)/, `${what} must import the helper`);
  }
});

test('no hand-written copy of the formula survives in those files', () => {
  /*
   * The de-duplication is the whole point, so its absence is asserted directly
   * rather than inferred from the import above — a file can import the helper
   * and still carry a stale second copy beside it, which is precisely how seven
   * copies accumulated.
   */
  const COPY = /total_charge \|\| 0\)\s*\*\s*Number\([a-z]*\.?quantity \|\| 1\)/;
  for (const file of ['routes/admin/jobs.js', 'routes/client/index.js', 'routes/admin/finance.js']) {
    const src = code(read(file));
    assert.ok(!COPY.test(src), `${file} still recomputes the line total by hand`);
  }
});

test('the invoice header interpolates the fragment rather than copying it', () => {
  /*
   * The header aggregates over a date range, so it cannot call the JS function
   * — which is exactly the case a copy-paste would be excused for. It must
   * interpolate.
   */
  const fin = code(read('routes/admin/finance.js'));
  assert.match(fin, /SUM\(\$\{LINE_TOTAL_SQL\('js'\)\}\)/, 'the header must interpolate the shared expression');
  assert.match(fin, /\$\{ACTIVE_SERVICES_SQL\('js'\)\}/, 'and the shared active-rows predicate');
  assert.ok(
    !/COALESCE\(js\.total_charge, 0\) \* COALESCE/.test(fin),
    'a literal copy of the expression must not reappear here',
  );
});
