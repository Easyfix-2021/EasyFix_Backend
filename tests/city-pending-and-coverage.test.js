/*
 * Automatically-created cities are PENDING, and a new pincode's Serviceable
 * flag is COMPUTED rather than asserted.
 *
 * Background (2026-09-09). Six paths create a tbl_city row automatically and
 * three of them need no CRM login — the public website booking, the technician
 * magic-link profile form, and AI transcript extraction. Every one inserted
 * `city_status = 1`, so a city went live the instant an unauthenticated caller
 * typed an unknown pincode. The same paths inserted `pincode_status = 1`
 * ("Serviceable" — defined as covered by ≥1 active, verified technician) with
 * literally no coverage, and the public serviceability endpoint then repeated
 * that claim to customers for a row the site itself had minted.
 *
 * WHY THESE ASSERT THE STATEMENT, NOT THE RESULT. Both changes are invisible in
 * the return value: ensurePincode returns the same row shape either way, and
 * findOrCreateCityByName returns the same { city_id, created }. The only thing
 * that moved is WHAT WAS WRITTEN, so the assertions are on the captured SQL and
 * its params. A test on the response would pass against the old code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { CITY_STATUS } = require(path.join(ROOT, 'lib/city-status'));

/** Replace the shared pool's methods before the service captures them. */
function installPool(handler) {
  const db = require(path.join(ROOT, 'db'));
  const calls = [];
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    calls.push({ sql: text, params });
    return [await handler(text, params), []];
  };
  return calls;
}

const cityInsert = (calls) => calls.find((c) => /INSERT INTO tbl_city/i.test(c.sql));
const pinInsert = (calls) => calls.find((c) => /INSERT INTO tbl_pincode/i.test(c.sql));

/*
 * Drive the REAL ensurePincode with the geocoder and the pool stubbed, and
 * assert what it WROTE. Source-text assertions were the first draft of this
 * file; they cannot see that the statement is actually reached, only that it
 * exists somewhere in the file.
 */
function loadServiceWith({ covered = false } = {}) {
  const stub = (rel, exports) => {
    const abs = require.resolve(path.join(ROOT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
  };
  const calls = [];
  stub('db', {
    pool: {
      async query(sql, params) {
        const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
        calls.push({ sql: text, params });
        if (/AS covered/i.test(text)) return [[{ covered: covered ? 1 : 0 }], []];
        if (/^\s*INSERT INTO tbl_city/i.test(text)) return [{ insertId: 90001 }, []];
        if (/^\s*INSERT INTO tbl_pincode/i.test(text)) return [{ insertId: 70001 }, []];
        if (/SHOW COLUMNS/i.test(text)) return [[], []];
        // The state MUST resolve, or ensurePincode falls through to
        // findOrCreateStateByName and dies on "no country configured in
        // tbl_country" — a failure about the fixture, not about the city.
        if (/FROM tbl_state WHERE LOWER\(TRIM\(state_name\)\)/i.test(text)) {
          return [[{ state_id: 21, state_name: 'Maharashtra' }], []];
        }
        // assertCityExists() re-reads the city we just minted. Keyed on
        // `WHERE city_id = ?` so the by-NAME lookups above still return empty
        // and the mint path is the one exercised.
        if (/FROM tbl_city\b[\s\S]*WHERE city_id = \?/i.test(text)) {
          return [[{ city_id: 90001, city_name: 'Newtown', state_id: 21 }], []];
        }
        // createPincode re-reads the row it just inserted (getPincodeById), so
        // the fixture has to hand it back or ensurePincode throws AFTER the
        // writes under test have already happened. Routing it keeps the test
        // end-to-end instead of asserting around an exception.
        if (/WHERE p\.pincode_id = \?|WHERE pincode_id = \?/i.test(text)) {
          return [[{ pincode_id: 70001, pincode: '401404', city_id: 90001,
                     pincode_status: 0, city_name: 'Newtown', state_name: 'Maharashtra' }], []];
        }
        // Everything else empty: no existing pincode, and no city matches by
        // exact name or fuzzy — which is exactly the "mint a new city" path.
        return [[], []];
      },
    },
    getPoolStats: () => ({}), poolSaturation: () => ({ status: 'ok' }),
    testConnection: async () => true, closePool: async () => {},
  });
  /*
   * The real seam is geocodePincodeDetail — geocodeAndMatch lives INSIDE
   * pincode.service.js and calls it. Stubbing the wrong one silently produced
   * "geocode.geocodePincodeDetail is not a function", which is the honest
   * failure: the stub had not reached the code under test at all.
   */
  stub('services/pincode-geocode.service', {
    geocodePincodeDetail: async () => ({
      geocoded: true, lat: 19.1, lng: 72.8,
      state: 'Maharashtra', district: 'Palghar', city: 'Newtown',
      country: 'India', country_code: 'IN',
    }),
    getCentroid: async () => null,
    getCentroids: async () => new Map(),
    haversineKm: () => 0,
    hasProvenanceColumn: async () => false,
  });
  for (const m of ['services/pincode.service']) delete require.cache[require.resolve(path.join(ROOT, m))];
  return { svc: require(path.join(ROOT, 'services/pincode.service')), calls };
}

test('RUNTIME: an auto-created city is WRITTEN pending, and the pincode uncovered', async () => {
  const { svc, calls } = loadServiceWith({ covered: false });
  await svc.ensurePincode('401404', {});

  const city = cityInsert(calls);
  assert.ok(city, 'a tbl_city INSERT must have been issued');
  assert.match(city.sql, /VALUES \(\?, \?, \?, 2, \?\)/,
    `the city must be written PENDING (2), not live. Got: ${city.sql.replace(/\s+/g, ' ')}`);

  const pin = pinInsert(calls);
  assert.ok(pin, 'a tbl_pincode INSERT must have been issued');
  assert.equal(pin.params[6], 0,
    'pincode_status must be 0 when nobody covers the pincode. A 1 here is the old hard-coded '
    + '`is_active: true`, which asserts coverage that does not exist and which the public '
    + 'serviceability endpoint then repeats to customers.');
  assert.ok(calls.some((c) => /AS covered/i.test(c.sql)), 'the coverage probe must actually run');
});

test('RUNTIME: a pincode a technician already serves is born Serviceable', async () => {
  // The positive control for the probe. If this also returned 0, the change
  // would be "always 0" rather than "computed", and the test above would pass
  // for the wrong reason.
  const { svc, calls } = loadServiceWith({ covered: true });
  await svc.ensurePincode('500007', {});
  const pin = pinInsert(calls);
  assert.ok(pin, 'a tbl_pincode INSERT must have been issued');
  assert.equal(pin.params[6], 1,
    'a covered pincode must be written Serviceable — otherwise the probe is not being consulted');
});

test('the fuzzy matcher can see PENDING cities, or duplicates accumulate', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'services/pincode.service.js'), 'utf8');
  const fuzzy = src.match(/SELECT city_id, city_name FROM tbl_city WHERE state_id = \? AND \([^)]*\)/);
  assert.ok(fuzzy, 'the fuzzy-match query must still exist');
  assert.match(fuzzy[0], /city_status = 2/,
    'a second pincode for the same town must fuzzy-match the city already awaiting approval. '
    + 'Without status 2 here, every near-duplicate mints ANOTHER pending row beside it.');
  assert.match(fuzzy[0], /city_status = 1/, 'active cities must still match');
  assert.doesNotMatch(fuzzy[0], /city_status = 0/, 'inactive cities must stay excluded');
});

test('a new pincode COMPUTES serviceability — it does not assert it', async () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'services/pincode.service.js'), 'utf8');
  const block = src.match(/lng:\s+match\.lng,[\s\S]{0,320}?is_active:[^\n]*/);
  assert.ok(block, 'ensurePincode must still build a createPincode payload');
  assert.doesNotMatch(block[0], /is_active:\s*true/,
    'ensurePincode hard-coded is_active: true until 2026-09-09. Serviceable is DEFINED as '
    + '"covered by at least one active, verified technician", so a literal true on a path with '
    + 'no operator asserts coverage nobody has — and the public serviceability endpoint '
    + 'repeats it to customers.');
  assert.match(block[0], /isPincodeCovered\(/, 'it must call the coverage probe');
});

test('the coverage probe uses the SAME predicate as the bulk recompute', () => {
  // Two different definitions of "serviceable" would be worse than the bug:
  // the value written at creation must be the value recomputeServiceableStatus
  // would later compute, or the manual refresh silently flips rows back.
  const src = require('fs').readFileSync(path.join(ROOT, 'services/pincode.service.js'), 'utf8');
  // Boundary-anchored: an unanchored /p\.pincode/ also matches INSIDE
  // \`sp.pincodes\`, rewriting it to \`sPINs\` and making the parity check fail
  // for a reason that has nothing to do with the predicate.
  const norm = (t) => t.replace(/\s+/g, ' ').replace(/(?<![a-z])p\.pincode(?![a-z])|\?/g, 'PIN').trim();

  const probe = src.match(/async function isPincodeCovered[\s\S]*?\n}/);
  const bulk = src.match(/async function recomputeServiceableStatus[\s\S]*?\n}/);
  assert.ok(probe && bulk, 'both the probe and the bulk recompute must exist');

  for (const clause of [
    'e.efr_status = 1',
    'e.is_technician_verified = 1',
    'FIND_IN_SET(PIN, sp.pincodes) > 0',
    'e.efr_pin_no = PIN',
  ]) {
    assert.ok(norm(probe[0]).includes(clause), `probe is missing: ${clause}`);
    assert.ok(norm(bulk[0]).includes(clause), `bulk recompute is missing: ${clause}`);
  }
});

test('the client city list offers SELECTABLE cities only', () => {
  /*
   * REVERSED 2026-09-09. This test used to assert the opposite — that inactive
   * cities stayed in the list, "because a client may have historical orders in
   * a city ops has switched off and the dropdown must still name it".
   *
   * That reasoning conflated naming with selecting. `?scope=all` has exactly
   * one consumer, Easyfix_client_UI's New Order form, whose own comment calls
   * it the "full active-city catalog"; a saved order resolves its city name
   * through that order's own JOIN, which is unfiltered and unaffected. So the
   * inactive rows bought no naming at all — and cost real harm, because
   * city_status = 0 is also where a REJECTED city lands. A rejected city has
   * had its rows merged into a replacement, and offering one lets a client
   * file a new order into a city that was explicitly decided against. The
   * merge forwarding in pincode.service.js cannot save this path: the client
   * submits a city_id, not a name.
   */
  const src = require('fs').readFileSync(path.join(ROOT, 'routes/client/index.js'), 'utf8');
  const q = src.match(/SELECT c\.city_id AS id, c\.city_name AS name[\s\S]{0,240}?ORDER BY c\.city_name ASC`[\s\S]{0,40}?\)/);
  assert.ok(q, 'the client scope=all city list must still exist');
  assert.match(q[0], /selectableCitySql\('c'\)/,
    'it must use the shared predicate rather than spelling the statuses out again — one '
    + 'definition of "may be offered for selection", in lib/city-status.js');
  assert.doesNotMatch(q[0], /city_status <> \?/,
    'excluding PENDING alone is what left rejected (0) cities offerable');

  // The helper is what the assertion above delegates to, so pin its meaning
  // here too — otherwise this test passes against a selectableCitySql() that
  // has been widened to include 0.
  const { selectableCitySql } = require(path.join(ROOT, 'lib/city-status'));
  const pred = selectableCitySql('c');
  assert.match(pred, /c\.city_status = 1/);
  assert.match(pred, /c\.city_status IS NULL/, 'legacy NULL-status rows are live and must stay offerable');
  assert.doesNotMatch(pred, /= 0|= 2/, 'neither rejected/inactive nor pending may be selectable');
});

test('the CRM picker already excludes anything that is not ACTIVE', () => {
  // lookup.service.js needed no change — it filters city_status = 1, so PENDING
  // is excluded for free. This test exists so that a future "relax the picker"
  // change has to confront the pending case explicitly.
  const src = require('fs').readFileSync(path.join(ROOT, 'services/lookup.service.js'), 'utf8');
  assert.match(src, /if \(!includeInactive\) clauses\.push\('city_status = 1'\)/,
    'the CRM city picker must filter to ACTIVE; = 1 is what keeps PENDING out');
  assert.match(src, /NOT status-filtered/,
    'the ids= preselect branch must stay unfiltered — a saved job has to resolve its city name '
    + 'even after that city is deactivated');
});
