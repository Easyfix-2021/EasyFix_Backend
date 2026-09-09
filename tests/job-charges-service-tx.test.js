'use strict';
/*
 * The Billing & Charges tab's Services row was wrong twice, and one of the two
 * had been wrong quietly for longer than anyone noticed.
 *
 *   tx     — hardcoded 0 in the frontend (BillingChargesTab: `{ label:
 *            'Services', client: servicesClient, tx: 0 }`), with a comment
 *            saying the backend contract offered nothing better. It didn't:
 *            getCharges selected `js.total_charge, js.quantity,
 *            approval_by_client, is_approved_by_pm` and no technician figure.
 *            So every service read as pure margin.
 *
 *   client — summed `js.total_charge` raw. That column is PER-UNIT despite its
 *            name (the writers store Math.round(unitPrice)), and the matrix
 *            never multiplied by quantity, so a qty-3 line was counted once.
 *            The column is also 0 on most older rows, which is exactly why
 *            job.service.js COALESCEs past it and the breakdown route prefers
 *            cs.total_amount. Three readers of one figure, three answers.
 *
 * Both now come from the rate-card cascade, through the SAME helper the
 * Services tab renders — services/job-service-breakdown.service.js — so the
 * two tabs of one modal cannot quote different money for one job.
 *
 * Runner: `node --test --test-force-exit tests/job-charges-service-tx.test.js`
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/*
 * A rate card with a clean cascade. Chosen so the four layers are distinct
 * integers and a mis-picked layer cannot coincidentally equal the right one —
 * every one of these numbers is a believable rupee figure, which is precisely
 * why a wrong pick would survive review.
 *
 *   unit price          1000
 *   L1 easyfix direct   10% = 100          -> 900 remains
 *   L2 overhead         fixed 50           -> 850 remains
 *   L3 client share     0                  -> 850 remains
 *   L4 remainder (TX)   850
 */
const RATE_CARD = {
  total_amount: 1000,
  easyfix_direct_fixed: 0, easyfix_direct_variable: 10,
  overhead_fixed: 50, overhead_variable: 0,
  client_fixed: 0, client_variable: 0,
};

const QTY = 3;

function serviceRows(overrides = {}) {
  return [{
    job_service_id: 77,
    service_id: 501,
    quantity: QTY,
    // Deliberately 0 — the state most live rows are in, and the state under
    // which the old code showed the whole line as free.
    total_charge: 0,
    service_type_name: 'Installation',
    service_catg_name: 'Carpentry',
    ...RATE_CARD,
    ...overrides,
  }];
}

/*
 * installFakePool patches METHODS on the shared db.pool singleton and the whole
 * suite runs in ONE process, so a fake left installed is not scoped to this
 * file — it reaches every test that runs after it. Leaving it installed here
 * failed 48 tests in unrelated suites (pincode coverage, image MIME sniffing)
 * with errors that pointed nowhere near the cause. So exactly one fake is live
 * at a time, and the last one is torn down when the file ends.
 */
let installed = null;
function restoreFake() {
  if (installed) { installed.restore(); installed = null; }
}
after(restoreFake);

/** Fresh module graph per case — getCharges captures `pool` at require time. */
function loadService(routes) {
  restoreFake();
  /*
   * The services are dropped so each case gets a clean module, but `../db` is
   * NOT: installFakePool patches the METHODS on the shared pool object, and
   * services hold a reference to that object. Evicting db would mint a second
   * pool, leaving the patch on an object nobody uses — the fake would look
   * installed and every query would try to reach a real database.
   */
  for (const m of [
    '../services/job-charges.service',
    '../services/job-service-breakdown.service',
  ]) delete require.cache[require.resolve(m)];
  installed = installFakePool(routes);
  return { svc: require('../services/job-charges.service'), fake: installed };
}

const BREAKDOWN_ROUTE = [/FROM tbl_job_services js[\s\S]*tbl_client_service cs/i, () => serviceRows()];
const BILLING_ROUTE = [/crc_ratecard_name/i, () => [{
  job_service_id: 77, service_name: 'Wardrobe 3 Door', total_charge: 0,
  quantity: QTY, approval_by_client: 0, is_approved_by_pm: 0,
}]];
const EMPTY_ROUTES = [
  [/FROM job_material/i, () => []],
  [/FROM tbl_job_image/i, () => []],
];

test('every service line carries a client charge and a technician charge', async () => {
  const { svc } = loadService([BILLING_ROUTE, BREAKDOWN_ROUTE, ...EMPTY_ROUTES]);
  const { services } = await svc.getCharges(42);

  assert.equal(services.length, 1);
  const s = services[0];
  assert.ok('client_charge' in s, 'the contract must expose a client charge');
  assert.ok('tx_charge' in s, 'and a technician charge — its absence is why the FE hardcoded 0');
});

test('both are LINE totals — per-unit x quantity, the half nobody noticed', async () => {
  /*
   * The regression test proper for the quieter bug. The old matrix summed the
   * per-unit column, so this line billed 1000 instead of 3000. A guard that
   * only checked "tx is no longer zero" would pass on that.
   */
  const { svc } = loadService([BILLING_ROUTE, BREAKDOWN_ROUTE, ...EMPTY_ROUTES]);
  const [s] = (await svc.getCharges(42)).services;

  assert.equal(s.client_charge, 3000, 'client must be unit price x quantity, not the per-unit column');
  assert.equal(s.tx_charge, 2550, 'tx must be the L4 residual x quantity (850 x 3)');
  assert.notEqual(s.client_charge, RATE_CARD.total_amount,
    'positive control: a per-unit answer must be distinguishable from the line total');
});

test('the numbers survive total_charge being 0 — the state most live rows are in', async () => {
  /*
   * The fixture's js.total_charge is 0 throughout. Under the old read that made
   * the whole line free; the cascade sources the price from
   * tbl_client_service.total_amount instead, which is why it does not.
   */
  const { svc } = loadService([BILLING_ROUTE, BREAKDOWN_ROUTE, ...EMPTY_ROUTES]);
  const [s] = (await svc.getCharges(42)).services;
  assert.equal(s.total_charge, 0, 'the raw column really is 0 in this fixture');
  assert.ok(s.client_charge > 0, 'yet the line is correctly priced');
});

test('tx never exceeds client — structural, not merely true of this fixture', async () => {
  /*
   * remainder is what is LEFT after the cascade subtracts its three layers from
   * totalCharge, so tx <= client by construction. Asserted across a spread of
   * rate cards rather than the one above, because the FE renders margin as
   * (client - tx) and a negative would be a visible, alarming number.
   */
  const cards = [
    { ...RATE_CARD },
    { ...RATE_CARD, easyfix_direct_variable: 0, overhead_fixed: 0 },      // nothing deducted
    { ...RATE_CARD, easyfix_direct_variable: 100 },                       // everything deducted
    { ...RATE_CARD, overhead_fixed: 99999 },                              // fixed leg exceeds the price
    { ...RATE_CARD, client_variable: 50 },                                // the L3 bucket in play
  ];
  for (const [i, card] of cards.entries()) {
    const { svc } = loadService([
      BILLING_ROUTE,
      [/FROM tbl_job_services js[\s\S]*tbl_client_service cs/i, () => serviceRows(card)],
      ...EMPTY_ROUTES,
    ]);
    const [s] = (await svc.getCharges(42)).services;
    assert.ok(
      s.tx_charge <= s.client_charge,
      `card ${i}: tx ${s.tx_charge} must not exceed client ${s.client_charge} — the FE renders client - tx`,
    );
    assert.ok(s.tx_charge >= 0, `card ${i}: a negative technician charge is never a valid answer`);
  }
});

test('an unresolvable rate card yields null, not 0 — a price and "unknown" differ', async () => {
  const { svc } = loadService([
    BILLING_ROUTE,
    // The breakdown returns nothing for this line (client_service row gone).
    [/FROM tbl_job_services js[\s\S]*tbl_client_service cs/i, () => []],
    ...EMPTY_ROUTES,
  ]);
  const [s] = (await svc.getCharges(42)).services;
  assert.equal(s.client_charge, null, '0 would render as free; null renders as unknown');
  assert.equal(s.tx_charge, null);
});

test('a failing breakdown does not take the whole tab down with it', async () => {
  /*
   * getCharges also carries the penalty / travel / incentive rows, the job-sheet
   * documents and the approval controls. Losing two numbers is recoverable;
   * losing the tab is not.
   */
  const { svc } = loadService([
    BILLING_ROUTE,
    [/FROM tbl_job_services js[\s\S]*tbl_client_service cs/i, () => { throw new Error('boom'); }],
    ...EMPTY_ROUTES,
  ]);
  const out = await svc.getCharges(42);
  assert.equal(out.services.length, 1, 'the services still come back');
  assert.equal(out.services[0].client_charge, null);
  assert.ok(out.documents, 'and so does everything else the tab needs');
});

// ── The source of the numbers, structurally ──────────────────────────

test('the stored charge columns are NOT what is read', () => {
  /*
   * tbl_job_services.easyfixer_charge exists and every create path in this
   * backend populates it, so reading it is the obvious move. It is still wrong:
   * it is written by utils/rate-card-calc.js::computeJobServiceCharges, a
   * DIFFERENT cascade that subtracts its fixed leg unclamped where
   * calculateCharges clamps with Math.min — so on a rate card whose fixed leg
   * exceeds what remains, the two disagree. It is also a snapshot, stale after
   * any later rate-card edit, and empty on rows written before 2026-06-03 or by
   * the still-live legacy Java CRM.
   */
  const svc = code(fs.readFileSync(path.join(ROOT, 'services/job-charges.service.js'), 'utf8'));
  for (const col of ['easyfixer_charge', 'easyfix_charge']) {
    assert.ok(!svc.includes(col), `${col} is a snapshot from a different cascade — it must not be read here`);
  }
  assert.match(
    svc,
    /serviceChargeMap/,
    'the figures must come from the shared breakdown helper',
  );
});

test('the breakdown route and the billing tab share ONE implementation', () => {
  /*
   * The point of the extraction. Two functions that agree today are not the
   * same as one function: this whole defect class — and the margin formula, and
   * the two status columns — began as two readers of one fact.
   */
  const routes = code(fs.readFileSync(path.join(ROOT, 'routes/admin/jobs.js'), 'utf8'));
  const charges = code(fs.readFileSync(path.join(ROOT, 'services/job-charges.service.js'), 'utf8'));

  assert.match(routes, /breakdownForJob/, 'the route must delegate to the shared service');
  assert.ok(
    !/calculateCharges/.test(routes),
    'the route must no longer run its own copy of the cascade',
  );
  assert.match(charges, /job-service-breakdown\.service/, 'and the billing service must use the same module');
});

test('both callers select the same service rows, or a line silently vanishes', () => {
  /*
   * getCharges and the breakdown run separate queries and are joined by
   * job_service_id. If their active-row predicates ever diverge, a row present
   * in one and absent from the other loses its charges with no error — it just
   * reads as unpriced.
   */
  const breakdown = fs.readFileSync(path.join(ROOT, 'services/job-service-breakdown.service.js'), 'utf8');
  const charges = fs.readFileSync(path.join(ROOT, 'services/job-charges.service.js'), 'utf8');
  const PREDICATE = /js\.job_service_status IS NULL OR js\.job_service_status <> 0/;
  assert.match(breakdown, PREDICATE, 'the breakdown must filter soft-deleted rows');
  assert.match(charges, PREDICATE, 'and the billing query must filter them identically');
});
