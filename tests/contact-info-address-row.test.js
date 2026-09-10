/*
 * The contact-info READ and WRITE must resolve the SAME tbl_address row.
 *
 * ─── WHY THIS IS THE PROPERTY WORTH PINNING ────────────────────────────────
 *
 * Not the ordering. If the write lands on a row the read ignores, the
 * technician saves an address, the screen reloads, and the old value comes
 * back — an edit that silently reverts, which is the exact failure this
 * endpoint was created to fix (reading from tbl_easyfixer while writing to
 * tbl_address). Any two resolvers that agree are correct; two that disagree are
 * catastrophic regardless of which one is "better".
 *
 * They used to agree by both spelling `ORDER BY address_id DESC LIMIT 1`. That
 * is an agreement nobody enforces: either could be edited alone, in a diff that
 * looks entirely reasonable, and nothing would fail. They now share one
 * constant, and this file is what keeps them sharing it.
 *
 * ─── AND WHY THE ORDERING CHANGED ──────────────────────────────────────────
 *
 * 6,787 of 6,788 technicians carry THREE address rows (address_type NULL on all
 * of them) and the newest is usually the empty one — 2,508 have a blank newest
 * row while an older row holds a real address. Newest-first showed a blank Edit
 * Profile to a third of the technicians who had one stored.
 *
 *   node --test --test-force-exit tests/contact-info-address-row.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mobile', 'index.js'), 'utf8');

/*
 * Comments are stripped first. This endpoint carries a long block explaining
 * the OLD ordering and naming it verbatim, so an assertion that merely looked
 * for `ORDER BY address_id DESC` would be satisfied by the prose describing why
 * it is gone.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/** The two statements that must agree, located by what they select. */
const READ = /SELECT \* FROM tbl_address WHERE user_id = \? \$\{(\w+)\}/;
const WRITE = /SELECT address_id FROM tbl_address WHERE user_id = \? \$\{(\w+)\}/;

test('both statements resolve the row through the SAME named fragment', () => {
  const read = CODE.match(READ);
  const write = CODE.match(WRITE);

  assert.ok(read, 'the contact-info READ must still select the address row by user_id.\n'
    + '  If it moved, move this test with it — do NOT delete the assertion, because\n'
    + '  the failure it guards is an address edit that appears to revert.');
  assert.ok(write, 'the contact-info WRITE must still resolve its target row by user_id');

  assert.equal(read[1], write[1],
    `the read resolves the row with \${${read[1]}} and the write with \${${write[1]}}.\n`
    + '  Two different fragments means the save can land on a row the next read\n'
    + '  ignores, and the technician watches his address revert.');
});

test('the shared fragment prefers a POPULATED row, then the newest', () => {
  const name = CODE.match(READ)[1];
  const decl = CODE.match(new RegExp(`const ${name}\\s*=\\s*([\\s\\S]{0,240}?);`));
  assert.ok(decl, `${name} must be declared in this file`);
  const sql = decl[1];

  assert.match(sql, /pin_code/,
    'the newest row is usually the EMPTY one — ordering must look at content,\n'
    + '  not only at address_id, or a third of technicians see a blank form');
  assert.match(sql, /address_id DESC/,
    'and must still fall back to the newest row, so a technician with no address\n'
    + '  anywhere keeps the previous behaviour exactly');
  assert.match(sql, /LIMIT 1/, 'exactly one row is the technician address');

  // The content test must come FIRST, or address_id decides everything and the
  // pin_code term is decoration.
  assert.ok(
    sql.indexOf('pin_code') < sql.indexOf('address_id DESC'),
    'the populated-row term must be the LEADING sort key. Behind `address_id\n'
    + '  DESC` it can never change the outcome, and the query would look fixed\n'
    + '  while behaving exactly as it did before.',
  );
});

test('neither site re-inlines a bare newest-row ordering', () => {
  const bare = CODE.match(/FROM tbl_address WHERE user_id = \?\s+ORDER BY address_id DESC/g) || [];
  assert.deepEqual(bare, [],
    'a statement went back to picking the newest row directly, bypassing the\n'
    + '  shared fragment — that is how the two halves drift apart');
});

console.log('contact-info: read and write share one row resolution');
