const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const registration = require('../services/mobile-registration.service');
const lifecycle = require('../services/easyfixer-lifecycle.service');

const originalFinalize = lifecycle.finalizeMobileRegistrationGate1;

function transactionDb({
  homeRow = null,
  resolvedPincodes = ['110001', '110062'],
  // Stored home pincode on tbl_easyfixer. '' = the technician has none yet.
  storedHome = '',
} = {}) {
  const defaultHome = {
    pincode: '110001',
    city_id: 12,
    city_name: 'New Delhi',
    district: 'New Delhi',
    state_name: 'Delhi',
  };
  const resolvedHome = homeRow === null ? defaultHome : homeRow;
  const events = [];
  const conn = {
    async beginTransaction() { events.push({ type: 'begin' }); },
    async commit() { events.push({ type: 'commit' }); },
    async rollback() { events.push({ type: 'rollback' }); },
    release() { events.push({ type: 'release' }); },
    async query(sql, params) {
      const text = String(sql);
      events.push({ type: 'query', sql: text, params });
      if (/FROM tbl_pincode p[\s\S]*LEFT JOIN tbl_city/i.test(text)) {
        return [resolvedHome ? [resolvedHome] : [], []];
      }
      if (/^\s*SELECT user_id, efr_pin_no FROM tbl_easyfixer/i.test(text)) {
        return [[{ user_id: 99, efr_pin_no: storedHome }], []];
      }
      if (/^\s*SELECT (?:DISTINCT )?pincode FROM tbl_pincode/i.test(text)) {
        return [resolvedPincodes.map((pincode) => ({ pincode })), []];
      }
      return [{ affectedRows: 1 }, []];
    },
  };
  return { events, conn, getConnection: async () => conn };
}

afterEach(() => {
  lifecycle.finalizeMobileRegistrationGate1 = originalFinalize;
});

test('atomically commits name, home location and full serviceable set before derived finalize', async () => {
  const database = transactionDb();
  lifecycle.finalizeMobileRegistrationGate1 = async (efrId) => {
    database.events.push({ type: 'finalize', efrId });
    return lifecycle._internals.resolveGate1Finalization(
      'REGISTRATION_INCOMPLETE',
      { personal_submitted: 1, adhaar_card_number: '', efr_profile_img: '' },
    );
  };

  const result = await registration.saveWorkArea(8379, {
    name: 'Ramesh Kumar Singh',
    homePincode: '110001',
    pincodes: ['110001', '110062'],
  }, database);

  assert.equal(result.ok, true);
  assert.equal(result.serviceablePincodesUpdated, 2);
  assert.equal(result.finalization.finalized, false, 'other incomplete gates make finalize a no-op');
  assert.equal(result.finalization.pending, true);
  assert.deepEqual(result.finalization.missing, ['aadhaar_number', 'profile_image']);
  const lifecycleEvents = database.events
    .filter((event) => ['begin', 'commit', 'rollback', 'release', 'finalize'].includes(event.type))
    .map((event) => event.type);
  assert.deepEqual(lifecycleEvents, ['begin', 'commit', 'release', 'finalize']);

  const easyfixerUpdate = database.events.find((event) => (
    event.type === 'query' && /UPDATE tbl_easyfixer[\s\S]*efr_cityId/i.test(event.sql)
  ));
  assert.ok(easyfixerUpdate);
  assert.deepEqual(easyfixerUpdate.params.slice(0, 5), [
    'Ramesh Kumar Singh',
    'Ramesh',
    'Kumar Singh',
    '110001',
    12,
  ]);

  const userUpdate = database.events.find((event) => (
    event.type === 'query' && /UPDATE tbl_user[\s\S]*pin_code/i.test(event.sql)
  ));
  assert.deepEqual(userUpdate.params, ['110001', 'New Delhi', 'Delhi', 99]);
  assert.ok(database.events.some((event) => (
    event.type === 'query' && /INSERT INTO tbl_efr_serviceable_pincodes/i.test(event.sql)
  )));
  assert.equal(
    database.events.filter((event) => event.type === 'query').length,
    7,
    'the combined contract stays within its fixed seven-query write budget before finalization',
  );
});

test('post-save finalization ACKs the committed write and defers another lifecycle conflict', async () => {
  const database = transactionDb();
  const lifecycleConflict = new Error('registration cannot be finalized from REAPPLIED');
  lifecycleConflict.status = 409;
  lifecycle.finalizeMobileRegistrationGate1 = async () => { throw lifecycleConflict; };

  const result = await registration.saveWorkArea(8379, {
    homePincode: '110001',
    pincodes: ['110001', '110062'],
  }, database);

  assert.equal(result.ok, true);
  assert.deepEqual(result.finalization, {
    finalized: false,
    schemaInstalled: null,
    lifecycle: null,
    pending: true,
    errorCode: 'REGISTRATION_FINALIZATION_DEFERRED',
  });
  assert.ok(database.events.some((event) => event.type === 'commit'));
});

test('post-save finalization ACKs the committed write when its follow-up query is transiently down', async () => {
  const database = transactionDb();
  const transient = new Error('database unavailable');
  transient.status = 503;
  lifecycle.finalizeMobileRegistrationGate1 = async () => { throw transient; };

  const result = await registration.saveWorkArea(8379, {
    homePincode: '110001',
    pincodes: ['110001', '110062'],
  }, database);

  assert.equal(result.ok, true);
  assert.equal(result.finalization.pending, true);
  assert.equal(result.finalization.errorCode, 'REGISTRATION_FINALIZATION_DEFERRED');
  assert.ok(database.events.some((event) => event.type === 'commit'));
});

test('automatic Gate-1 finalization reports incomplete cards without failing the durable operation', async () => {
  lifecycle.finalizeMobileRegistrationGate1 = async () => (
    lifecycle._internals.resolveGate1Finalization(
      'REGISTRATION_INCOMPLETE',
      { personal_submitted: 1, adhaar_card_number: '', efr_profile_img: '' },
    )
  );

  const result = await registration.finalizeGate1IfReady(8379);
  assert.equal(result.finalized, false);
  assert.equal(result.pending, true);
  assert.deepEqual(result.missing, ['aadhaar_number', 'profile_image']);
});

test('automatic Gate-1 finalization still rejects transient failures for durable retry', async () => {
  const transient = new Error('database unavailable');
  transient.status = 503;
  lifecycle.finalizeMobileRegistrationGate1 = async () => { throw transient; };

  await assert.rejects(
    registration.finalizeGate1IfReady(8379),
    (error) => error === transient,
  );
});

test('rolls back every work-area write when serviceable pincode resolution fails', async () => {
  const database = transactionDb({ resolvedPincodes: [] });
  let finalized = false;
  lifecycle.finalizeMobileRegistrationGate1 = async () => {
    finalized = true;
    return { changed: false, schemaInstalled: true, lifecycle: null };
  };

  await assert.rejects(
    registration.saveWorkArea(8379, {
      name: 'Ramesh Kumar Singh',
      homePincode: '110001',
      pincodes: ['110001', '110062'],
    }, database),
    /No valid pincodes resolved/i,
  );
  assert.deepEqual(
    database.events
      .filter((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type))
      .map((event) => event.type),
    ['begin', 'rollback', 'release'],
  );
  assert.equal(finalized, false);
});

test('rolls back a partial serviceable-pincode replacement instead of acknowledging dropped PINs', async () => {
  const database = transactionDb({ resolvedPincodes: ['110001'] });
  let finalized = false;
  lifecycle.finalizeMobileRegistrationGate1 = async () => {
    finalized = true;
    return { changed: false, schemaInstalled: true, lifecycle: null };
  };

  await assert.rejects(
    registration.saveWorkArea(8379, {
      homePincode: '110001',
      pincodes: ['110001', '110062'],
    }, database),
    (error) => error.status === 422 && /one or more serviceable pincodes/i.test(error.message),
  );
  assert.deepEqual(
    database.events
      .filter((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type))
      .map((event) => event.type),
    ['begin', 'rollback', 'release'],
  );
  assert.equal(finalized, false);
});

test('rejects a serviceable set that omits the Home PIN before acquiring a connection', async () => {
  let connected = false;
  await assert.rejects(
    registration.saveWorkArea(8379, {
      name: 'Ramesh',
      homePincode: '110001',
      pincodes: ['110062'],
    }, {
      async getConnection() {
        connected = true;
        throw new Error('must not connect');
      },
    }),
    (error) => error.status === 400 && /included/i.test(error.message),
  );
  assert.equal(connected, false);
});

test('allows Work Area before Identity by preserving an absent name', async () => {
  const database = transactionDb({ resolvedPincodes: ['110001'] });
  lifecycle.finalizeMobileRegistrationGate1 = async () => ({
    changed: false,
    schemaInstalled: true,
    lifecycle: { status: 'REGISTRATION_INCOMPLETE' },
  });

  const result = await registration.saveWorkArea(8379, {
    homePincode: '110001',
    pincodes: ['110001'],
  }, database);
  assert.equal(result.name, null);
  const easyfixerUpdate = database.events.find((event) => (
    event.type === 'query' && /UPDATE tbl_easyfixer[\s\S]*efr_cityId/i.test(event.sql)
  ));
  assert.equal(easyfixerUpdate.params[0], null, 'COALESCE must preserve the existing name');
});

/*
 * Home pincode is WRITE-ONCE (product rule, 2026-09-07).
 *
 * The technician's home lives in tbl_easyfixer.efr_pin_no; the serviceable set
 * is an unordered CSV with no "home" marker, so a client that derives the home
 * from `selected[0]` proposes a different PIN on every round-trip. The service
 * must keep the stored one, and must still guarantee it is in the persisted
 * serviceable set (rule (b)) even when the client's list omitted it.
 */
test('never overwrites an existing home pincode, and keeps it in the serviceable set', async () => {
  const database = transactionDb({
    storedHome: '110062',
    resolvedPincodes: ['110062', '110001', '110005'],
  });
  lifecycle.finalizeMobileRegistrationGate1 = async () => ({
    changed: false,
    schemaInstalled: true,
    lifecycle: { status: 'REGISTRATION_INCOMPLETE' },
  });

  const result = await registration.saveWorkArea(8379, {
    homePincode: '110001',
    pincodes: ['110001', '110005'],
  }, database);

  assert.equal(result.homePincode, '110062', 'the stored home survives the save');
  assert.equal(result.homePincodeKept, true);

  const easyfixerUpdate = database.events.find((event) => (
    event.type === 'query' && /UPDATE tbl_easyfixer[\s\S]*efr_cityId/i.test(event.sql)
  ));
  assert.equal(easyfixerUpdate.params[3], null, 'efr_pin_no must not be rewritten');
  assert.equal(easyfixerUpdate.params[4], null, 'the city FK follows the home pincode');

  const userUpdate = database.events.find((event) => (
    event.type === 'query' && /UPDATE tbl_user[\s\S]*pin_code/i.test(event.sql)
  ));
  assert.deepEqual(
    userUpdate.params,
    [null, null, null, 99],
    'the tbl_user mirror must not drift onto the rejected pincode',
  );

  // Rule (b): the effective home is in the persisted set even though the
  // client never sent it.
  const insert = database.events.find((event) => (
    event.type === 'query' && /INSERT INTO tbl_efr_serviceable_pincodes/i.test(event.sql)
  ));
  assert.equal(insert.params[1], '110062,110001,110005');
  assert.deepEqual(result.pincodes, ['110062', '110001', '110005']);
});

test('adopts the submitted pincode as home when the technician has none stored', async () => {
  const database = transactionDb({ storedHome: '', resolvedPincodes: ['110001', '110062'] });
  lifecycle.finalizeMobileRegistrationGate1 = async () => ({
    changed: false,
    schemaInstalled: true,
    lifecycle: { status: 'REGISTRATION_INCOMPLETE' },
  });

  const result = await registration.saveWorkArea(8379, {
    homePincode: '110001',
    pincodes: ['110001', '110062'],
  }, database);

  assert.equal(result.homePincode, '110001');
  assert.equal(result.homePincodeKept, false);
  const easyfixerUpdate = database.events.find((event) => (
    event.type === 'query' && /UPDATE tbl_easyfixer[\s\S]*efr_cityId/i.test(event.sql)
  ));
  assert.equal(easyfixerUpdate.params[3], '110001');
  assert.equal(easyfixerUpdate.params[4], 12, 'the resolved city FK is written with the first home');
});

test('re-saving the SAME home still backfills a half-enriched city FK', async () => {
  const database = transactionDb({ storedHome: '110001', resolvedPincodes: ['110001'] });
  lifecycle.finalizeMobileRegistrationGate1 = async () => ({
    changed: false,
    schemaInstalled: true,
    lifecycle: { status: 'REGISTRATION_INCOMPLETE' },
  });

  const result = await registration.saveWorkArea(8379, {
    homePincode: '110001',
    pincodes: ['110001'],
  }, database);

  assert.equal(result.homePincodeKept, false);
  const easyfixerUpdate = database.events.find((event) => (
    event.type === 'query' && /UPDATE tbl_easyfixer[\s\S]*efr_cityId/i.test(event.sql)
  ));
  assert.equal(easyfixerUpdate.params[4], 12, 'an unchanged home must not block city-FK backfill');
});
