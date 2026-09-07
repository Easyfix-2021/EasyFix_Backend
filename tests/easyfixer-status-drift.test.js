'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIFECYCLE_STATUSES,
  LEGACY_ACTIVE_STATUSES,
  statusDriftSql,
  _internals,
} = require('../services/easyfixer-lifecycle.service');

const { legacyStatusForTransition, reconciledStatusFor } = _internals;

/*
 * Status drift = tbl_easyfixer.efr_status disagreeing with lifecycle_status on
 * a verified technician.
 *
 * It cannot be produced by this backend: transition() writes both columns in a
 * single UPDATE via legacyStatusForTransition(). So a disagreement proves an
 * outside write — the still-live legacy Java CRM, which flips efr_status alone
 * — and, because our own writes always leave the pair agreeing, that outside
 * write is necessarily the LATER one. That is the whole justification for the
 * heal adopting the legacy bit rather than the other way round.
 *
 * The cost of leaving it: easyfixer-work-eligibility.sqlPredicate ANDs the two
 * halves, so a drifted technician receives no job offers at all while every
 * screen ops uses reads Active.
 */

test('the drift predicate names exactly the states the writer marks efr_status = 1', () => {
  /*
   * Derived from the WRITER, not copied from it. If a new work-enabled state is
   * ever added, legacyStatusForTransition starts returning 1 for it and this
   * assertion fails unless LEGACY_ACTIVE_STATUSES followed — which is what stops
   * the drift CHECK from drifting away from the invariant it checks.
   */
  const writesLegacyActive = LIFECYCLE_STATUSES
    .filter((status) => legacyStatusForTransition(status, 0) === 1);

  assert.deepEqual(
    [...LEGACY_ACTIVE_STATUSES].sort(),
    writesLegacyActive.sort(),
    'LEGACY_ACTIVE_STATUSES must equal the set legacyStatusForTransition() writes 1 for',
  );
  assert.ok(writesLegacyActive.length > 0, 'positive control: the writer must mark SOMETHING active');

  const sql = statusDriftSql('e');
  for (const status of writesLegacyActive) {
    assert.match(sql, new RegExp(`'${status}'`), `${status} must appear in the drift predicate`);
  }
  for (const status of LIFECYCLE_STATUSES.filter((s) => !writesLegacyActive.includes(s))) {
    assert.doesNotMatch(
      sql,
      new RegExp(`'${status}'`),
      `${status} is work-blocked and must NOT be listed as legacy-active`,
    );
  }
});

test('the drift predicate looks at both directions, and only at verified rows', () => {
  const sql = statusDriftSql('e');
  // efr_status = 1 under a blocked lifecycle: ops reactivated in the legacy CRM.
  assert.match(sql, /efr_status = 1 AND e\.lifecycle_status NOT IN/);
  // efr_status = 0 under a work-enabled lifecycle: the same defect, other face.
  assert.match(sql, /efr_status = 0 AND e\.lifecycle_status IN/);
  // Before verification efr_status carries no agreed meaning, and every
  // pre-verification state is work-blocked — including them would report the
  // whole onboarding funnel as drift.
  assert.match(sql, /is_technician_verified = 1/);
  // A row that never reached the migration has nothing to contradict.
  assert.match(sql, /lifecycle_status IS NOT NULL/);
  assert.equal(statusDriftSql('x').includes('x.efr_status'), true, 'alias must be honoured');
});

/*
 * The full resolution table for the heal. This IS the safety argument, so it is
 * asserted exhaustively rather than sampled.
 */
const VERIFIED = { is_technician_verified: 1 };

test('a legacy reactivation is adopted, mapping to the manager-correct state', () => {
  for (const blocked of ['INACTIVE', 'PAUSED', 'SUSPENDED', 'DORMANT', 'OFFLINE', 'ON_BENCH']) {
    assert.equal(
      reconciledStatusFor({ ...VERIFIED, efr_status: 1 }, { status: blocked }),
      'ACTIVE',
      `${blocked} + efr_status=1 must adopt ACTIVE`,
    );
    assert.equal(
      reconciledStatusFor({ ...VERIFIED, efr_status: 1, efr_manager_id: 7 }, { status: blocked }),
      'UNDER_MASTER',
      `${blocked} + efr_status=1 + a master mapping must adopt UNDER_MASTER, not ACTIVE`,
    );
  }
});

test('a legacy deactivation is adopted too — the heal is not one-way', () => {
  for (const enabled of LEGACY_ACTIVE_STATUSES) {
    assert.equal(
      reconciledStatusFor({ ...VERIFIED, efr_status: 0 }, { status: enabled }),
      'INACTIVE',
      `${enabled} + efr_status=0 must adopt INACTIVE`,
    );
  }
});

test('BLACKLISTED is never lifted by a legacy status flip', () => {
  /*
   * The one state the heal refuses to touch. Everything else it moves is an
   * operational judgement an admin may reverse in either CRM; a blacklist is a
   * deliberate safety decision, and a bit flipped in the legacy CRM must not
   * undo one silently. These rows stay drifted, and stay counted, for a human.
   */
  assert.equal(
    reconciledStatusFor({ ...VERIFIED, efr_status: 1 }, { status: 'BLACKLISTED' }),
    'BLACKLISTED',
  );
  assert.equal(
    reconciledStatusFor({ ...VERIFIED, efr_status: 1, efr_manager_id: 3 }, { status: 'BLACKLISTED' }),
    'BLACKLISTED',
  );
});

test('unverified rows are left alone whatever efr_status says', () => {
  for (const verified of [null, 0, undefined]) {
    assert.equal(
      reconciledStatusFor({ is_technician_verified: verified, efr_status: 1 }, { status: 'NEW' }),
      'NEW',
    );
    assert.equal(
      reconciledStatusFor(
        { is_technician_verified: verified, efr_status: 1 },
        { status: 'REGISTRATION_INCOMPLETE' },
      ),
      'REGISTRATION_INCOMPLETE',
      'an onboarding technician must never be activated by a legacy bit',
    );
  }
});

test('rows that already agree resolve to themselves, so the heal is a no-op', () => {
  /*
   * reconcileLegacyStatus passes _protectLifecycle: current === target, so
   * "resolves to itself" is what makes a scan over agreeing rows write nothing.
   */
  for (const status of LIFECYCLE_STATUSES) {
    const legacy = legacyStatusForTransition(status, 0);
    if (legacy == null) continue;
    assert.equal(
      reconciledStatusFor({ ...VERIFIED, efr_status: legacy }, { status }),
      status,
      `${status} with its own legacy bit (${legacy}) must not move`,
    );
  }
});

test('positive control — the resolver actually moves something', () => {
  /*
   * Every assertion above except the two adoption tests passes for a resolver
   * stubbed to `current.status`. This one fails for it, so a heal that has
   * quietly become an identity function cannot pass the file.
   */
  assert.notEqual(
    reconciledStatusFor({ ...VERIFIED, efr_status: 1 }, { status: 'INACTIVE' }),
    'INACTIVE',
  );
});
