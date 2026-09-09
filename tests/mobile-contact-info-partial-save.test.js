/*
 * A partial address save must not erase the fields it did not mention.
 *
 * POST /api/mobile/profile/contact-info validates every field as OPTIONAL with
 * Joi `.min(1)`, so a body carrying one field is a legal request. The handler
 * then built its UPDATE from "which columns EXIST on tbl_address" rather than
 * "which fields the caller SENT", with `b.houseNo ?? null` supplying a null for
 * everything absent.
 *
 * So `POST { pinCode: "110001" }` wrote:
 *
 *   UPDATE tbl_address SET house_no=NULL, locality=NULL, landmark=NULL,
 *     pin_code='110001', district=NULL, state=NULL, city_id=NULL, city1=NULL,
 *     city=NULL, is_address_details_filled=1 WHERE address_id=?
 *
 * This is strictly worse than the empty-string-overwrite trap this repo already
 * documents: that one needs a blank input, this one needs only an OMITTED
 * field — which is precisely what a screen rendering a subset of the address
 * sends. The Edit Profile screen is such a screen.
 *
 * The distinction the fix must preserve, and the reason `sent` is
 * hasOwnProperty rather than a truthiness test: an EXPLICIT null is a real
 * request to clear a column ("the technician deleted their landmark") and is
 * not the same as the field being absent ("this screen does not show
 * landmark"). Collapsing them would trade a data-loss bug for an
 * unable-to-clear bug.
 *
 *   node --test --test-force-exit tests/mobile-contact-info-partial-save.test.js
 */
'use strict';

process.env.NOTIFICATIONS_DISABLE = 'true';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'mobile', 'index.js'), 'utf8',
);

/*
 * The handler is mounted behind requireTechAuth and reads the live column set,
 * so driving it end-to-end would need the whole mobile router. What is under
 * test is the SET-list construction, which is self-contained: lift it out and
 * exercise it directly, the same way the walkthrough tests lift a screen's pure
 * exports.
 */
function buildPresent(body, liveColumns) {
  const start = ROUTE_SRC.indexOf('const sent = (key) =>');
  assert.notEqual(start, -1,
    'the contact-info handler must still build its column list from a `sent` predicate.\n'
    + '  If this moved, move the test with it — do NOT delete the assertion, because\n'
    + '  the failure mode it guards is silent data loss.');
  const end = ROUTE_SRC.indexOf('.map(([c, v]) => [c, v]);', start);
  assert.notEqual(end, -1, 'the present-list construction must still end with the map');

  const fragment = ROUTE_SRC.slice(start, end + '.map(([c, v]) => [c, v]);'.length);
  // eslint-disable-next-line no-new-func
  return new Function('b', 'cols', `${fragment}\nreturn present;`)(body, liveColumns);
}

const ALL_COLUMNS = new Set([
  'house_no', 'locality', 'landmark', 'pin_code', 'district', 'state',
  'city_id', 'city1', 'city', 'is_address_details_filled',
]);

let present = [];
const columnsWritten = () => present.map(([c]) => c).sort();
const valueOf = (col) => present.find(([c]) => c === col)?.[1];

beforeEach(() => { present = []; });

test('a pincode-only save touches ONLY pin_code — this is the data-loss case', () => {
  present = buildPresent({ pinCode: '110001' }, ALL_COLUMNS);

  assert.deepEqual(columnsWritten(), ['is_address_details_filled', 'pin_code']);
  for (const erased of ['house_no', 'locality', 'landmark', 'district', 'state', 'city_id', 'city1', 'city']) {
    assert.equal(
      present.some(([c]) => c === erased), false,
      `${erased} was not sent and must not appear in the UPDATE — it previously\n`
      + '  went out as NULL and erased the technician\'s stored address',
    );
  }
});

test('an explicit null still clears the column — absent and cleared are different requests', () => {
  present = buildPresent({ landMark: null }, ALL_COLUMNS);

  assert.ok(present.some(([c]) => c === 'landmark'),
    'an explicitly-null landMark is a request to CLEAR it, and must be written');
  assert.equal(valueOf('landmark'), null);
  assert.equal(present.some(([c]) => c === 'house_no'), false,
    'and it must not drag the untouched columns along with it');
});

test('an empty string is sent, not swallowed', () => {
  present = buildPresent({ houseNo: '' }, ALL_COLUMNS);
  assert.equal(valueOf('house_no'), '');
});

test('a full save still writes every column', () => {
  present = buildPresent({
    houseNo: '12', areaOrLocation: 'Sector 44', landMark: 'Near park',
    pinCode: '122001', district: 'Gurugram', state: 'Haryana',
    cityId: 5, city: 'Gurugram',
  }, ALL_COLUMNS);

  assert.deepEqual(columnsWritten(), [
    'city', 'city1', 'city_id', 'district', 'house_no',
    'is_address_details_filled', 'landmark', 'locality', 'pin_code', 'state',
  ]);
});

test('city and city1 share one field, so they are sent or omitted together', () => {
  present = buildPresent({ city: 'Gurugram' }, ALL_COLUMNS);
  assert.deepEqual(columnsWritten(), ['city', 'city1', 'is_address_details_filled']);

  present = buildPresent({ pinCode: '110001' }, ALL_COLUMNS);
  assert.equal(present.some(([c]) => c === 'city1'), false,
    'city1 carries b.city — with no city sent, neither spelling may be written');
});

test('the derived flag is always written, since no caller supplies it', () => {
  present = buildPresent({ pinCode: '110001' }, ALL_COLUMNS);
  assert.equal(valueOf('is_address_details_filled'), 1);
});

test('a column absent from the live table is skipped even when sent', () => {
  // Schema drift: this deployment has no `landmark`.
  const drifted = new Set([...ALL_COLUMNS].filter((c) => c !== 'landmark'));
  present = buildPresent({ landMark: 'Near park', pinCode: '110001' }, drifted);

  assert.equal(present.some(([c]) => c === 'landmark'), false,
    'writing a column this table does not have would throw ER_BAD_FIELD_ERROR');
  assert.ok(present.some(([c]) => c === 'pin_code'));
});

console.log('contact-info partial save: only sent fields are written; explicit null still clears');
