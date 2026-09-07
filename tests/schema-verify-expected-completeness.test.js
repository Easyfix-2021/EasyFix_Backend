'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyExpectedIsComplete, _internals } = require('../scripts/schema-verify');

/*
 * EXPECTED's completeness, asserted rather than merely printed.
 *
 * verifyExpectedIsComplete() already computes this, but only the CLI reads it,
 * and the CLI's exit code is shared with the live-DB pass — so on a host where a
 * hardening invariant is legitimately still pending (the active-Aadhaar UNIQUE,
 * blocked on an audited Ops decision since 2026-08-12) the run is red anyway and
 * a regression in THIS pass changes nothing anybody can see. One exit code
 * cannot carry two independent verdicts. This file gives the completeness pass
 * its own.
 *
 * It also needs no database, which is the other half of the point: the contract
 * is derived from the source tree, so this runs in CI with no DB reachable.
 */

test('EXPECTED lists every column the code\'s own SQL names', () => {
  const { unlisted } = verifyExpectedIsComplete();
  assert.deepEqual(
    unlisted.map((u) => `${u.table}.${u.col}  (${u.rel})`),
    [],
    'each of these is named by a live query and guarded by nothing — add it to '
    + 'EXPECTED in scripts/schema-verify.js',
  );
});

/*
 * THE POSITIVE CONTROL, and the reason it is in the file rather than in a
 * reviewer's memory: the assertion above is an empty-list comparison, and an
 * empty list is exactly what a scanner returns when it has stopped scanning.
 * A repo-walk that silently reads zero files, a parser that throws and is
 * caught, an EXPECTED whose keys stop matching the table names the scan
 * produces — every one of those makes the test above pass forever.
 *
 * So: take a column back out of EXPECTED and require that it comes back as
 * unlisted. `tbl_job.magic_link_sent_at` is the one verifyExpectedIsComplete's
 * own docblock cites as the miss that motivated it, and three runtime files
 * name it, so it is the least likely entry in the map to stop being referenced.
 */
test('the completeness check can actually fail (remove one column, it reappears)', () => {
  const table = 'tbl_job';
  const column = 'magic_link_sent_at';
  const original = _internals.EXPECTED[table];
  assert.ok(original.includes(column), `${table}.${column} must be listed for this control to mean anything`);

  _internals.EXPECTED[table] = original.filter((c) => c !== column);
  try {
    const { unlisted } = verifyExpectedIsComplete();
    assert.ok(
      unlisted.some((u) => u.table === table && u.col.toLowerCase() === column),
      `removing ${table}.${column} from EXPECTED must make the check report it; `
      + 'it did not, so the check is not reading the source tree at all',
    );
  } finally {
    _internals.EXPECTED[table] = original;
  }

  // …and restoring it must make the check clean again, so the control proves the
  // column is what moved the result and not some unrelated drift mid-test.
  assert.deepEqual(verifyExpectedIsComplete().unlisted, []);
});
