/*
 * The technician app's cancel / reschedule endpoints are REQUESTS, not actions.
 *
 * A technician asks; ops actions the ask from the CRM. The Node port had briefly
 * made both endpoints perform the action directly, and the two failure modes
 * that produced are what most of this file exists to keep out:
 *
 *   - cancel ran jobService.setStatus(6), i.e. a technician could CANCEL a
 *     customer's job unilaterally, firing the CancelJob webhook and the
 *     customer SMS off a tap nobody had approved.
 *   - reschedule wrote `requested_date_time`, i.e. it MOVED THE REAL
 *     APPOINTMENT — and, because it parsed the app's bare wall-clock string
 *     with new Date() in a UTC container, usually to the wrong hour as well.
 *
 * So the assertions are mostly about what is NOT written. Two of them are
 * negative by construction and would pass against an empty statement list, so
 * each is paired with a positive control that the statement they scan actually
 * ran and actually contains the columns it is supposed to contain.
 *
 * Runner: node --test --test-force-exit tests/mobile-cancel-reschedule-request.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

const JOB_ID = 7431;
const EFR_ID = 88;
const PM_MOBILE = '9876543210';

// Reassigned per-test; the pool closures read them.
let ownedByEfr = EFR_ID;
let pmRow = null;
let failAudit = false;

const fake = installFakePool([
  // getOwnedJob — the ownership guard both entry points run first.
  [/SELECT\s+job_id,\s*job_status/i, () => [{
    job_id: JOB_ID, job_status: 1, fk_easyfixter_id: ownedByEfr,
    fk_customer_id: 1, fk_client_id: 1, otp: null,
  }]],
  // The PM-notification context read (reschedule only).
  [/LEFT JOIN tbl_user\s+pm/i, () => (pmRow ? [pmRow] : [{}])],
  [/INSERT\s+INTO\s+tbl_easyfixer_call_record/i, () => {
    if (failAudit) throw new Error('ER_LOCK_WAIT_TIMEOUT: audit table busy');
    return { insertId: 1 };
  }],
  [/INSERT\s+INTO\s+tbl_job_comment/i, () => {
    if (failAudit) throw new Error('ER_LOCK_WAIT_TIMEOUT: audit table busy');
    return { insertId: 2 };
  }],
  [/UPDATE\s+tbl_job\s+SET/i, () => ({ affectedRows: 1 })],
]);

/*
 * Stub the WhatsApp sender on the MODULE OBJECT before the service captures it.
 * mobile-job-lifecycle does `const gallabox = require(...)` and then calls
 * gallabox.sendTemplate(...), so replacing the method here is seen by the
 * service. Not stubbing it would put a real fetch to Gallabox in the suite.
 */
const gallabox = require('../services/gallabox.whatsapp.service');
const realSendTemplate = gallabox.sendTemplate;
let waSends = [];
gallabox.sendTemplate = async (args) => { waSends.push(args); return { delivered: true }; };

const lifecycle = require('../services/mobile-job-lifecycle.service');
const jobService = require('../services/job.service');
const lookup = require('../services/lookup.service');

after(() => {
  gallabox.sendTemplate = realSendTemplate;
  fake.restore();
});

beforeEach(() => {
  ownedByEfr = EFR_ID;
  failAudit = false;
  pmRow = {
    pm_name: 'Veer', pm_mobile: PM_MOBILE,
    technician_name: 'Ravi', customer_name: 'Asha',
    reason_desc: 'Customer not responding',
  };
  waSends = [];
  fake.reset();
});

// ── helpers ────────────────────────────────────────────────────────────────
const jobUpdates = () => fake.calls.filter((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql));
const oneJobUpdate = () => {
  const rows = jobUpdates();
  assert.equal(rows.length, 1, 'expected exactly one tbl_job UPDATE, saw ' + rows.length);
  return rows[0];
};
const oneMatching = (re) => {
  const hits = fake.calls.filter((c) => re.test(c.sql));
  assert.equal(hits.length, 1, 'expected exactly one statement matching ' + re + ', saw ' + hits.length);
  return hits[0];
};

// ═══════════════════════════ CANCEL ═══════════════════════════════════════

test('cancel records a REQUEST — job_status stays at the pending code, never 6', async () => {
  await lifecycle.cancel(JOB_ID, EFR_ID, { reason: 'customer did it himself', reasonId: 267 });

  const upd = oneJobUpdate();
  // POSITIVE CONTROL for the two negative assertions below: this statement is
  // the one that would carry a cancellation if one were being performed.
  assert.match(upd.sql, /job_status = \?/, 'the UPDATE must be the one that sets job_status');
  assert.match(upd.sql, /is_cancelled_by_app = 1/);

  // Derived from the service's own constant, not a typed literal.
  assert.equal(upd.params[0], lifecycle.STATUS_REQUEST_PENDING);
  assert.notEqual(lifecycle.STATUS_REQUEST_PENDING, jobService.STATUS.CANCELLED);

  // NOT a cancellation: none of the actioned-cancellation columns are touched.
  assert.doesNotMatch(upd.sql, /\bcancel_reason_id\b/, 'cancel_reason_id belongs to an ops-actioned cancellation');
  assert.doesNotMatch(upd.sql, /\bcancel_by\b/, 'cancel_by belongs to an ops-actioned cancellation');
  // And no statement anywhere in the flow moved the job to CANCELLED.
  const movedToCancelled = fake.calls.some((c) =>
    /UPDATE\s+tbl_job/i.test(c.sql) && /job_status/i.test(c.sql)
    && (c.params || []).includes(jobService.STATUS.CANCELLED));
  assert.equal(movedToCancelled, false, 'a cancel REQUEST must never transition the job to CANCELLED');
});

test('cancel stamps the ask: date, comment, both reason slots, and the remarks mirror', async () => {
  const before = new Date();
  await lifecycle.cancel(JOB_ID, EFR_ID, { reason: 'customer did it himself', reasonId: 267 });
  const upd = oneJobUpdate();

  for (const col of [
    'cancel_date_time', 'cancel_comment', 'job_cancel_reason_id_by_easyfixer',
    'enum_reason_id', 'remarks', 'remarks_date_time',
  ]) {
    assert.match(upd.sql, new RegExp(col + ' = \\?'), col + ' must be stamped by the request');
  }
  // Values, in bind order: status, cancel_date_time, cancel_comment,
  // job_cancel_reason_id_by_easyfixer, enum_reason_id, remarks,
  // remarks_date_time, job_id, efr_id.
  const [, cancelAt, cancelComment, appReasonId, enumReasonId, remarks, remarksAt, jobId, efrId] = upd.params;
  assert.ok(cancelAt instanceof Date && cancelAt >= before, 'cancel_date_time is stamped now');
  assert.equal(cancelComment, 'customer did it himself');
  assert.equal(appReasonId, 267);
  assert.equal(enumReasonId, 267, 'the reason is mirrored onto the generic slot the Remarks history resolves');
  assert.equal(remarks, 'customer did it himself');
  assert.ok(remarksAt instanceof Date);
  assert.equal(jobId, JOB_ID);
  // The second ownership guard: the write is pinned to the technician's own job.
  assert.match(upd.sql, /WHERE job_id = \? AND fk_easyfixter_id = \?/);
  assert.equal(efrId, EFR_ID);
});

test('cancel leaves the two audit trails, and sends NO WhatsApp', async () => {
  await lifecycle.cancel(JOB_ID, EFR_ID, { reason: 'not needed', reasonId: 269 });

  const call = oneMatching(/INSERT\s+INTO\s+tbl_easyfixer_call_record/i);
  // action/source are ENUM columns — a value outside the enum stores NULL
  // rather than erroring, so the literals are pinned here.
  assert.match(call.sql, /'app'/, "source must be the 'app' enum member");
  assert.ok(call.params.includes('cancelled'), "action must be the 'cancelled' enum member");
  assert.ok(call.params.includes(JOB_ID) && call.params.includes(EFR_ID));

  const comment = oneMatching(/INSERT\s+INTO\s+tbl_job_comment/i);
  assert.ok(comment.params.includes(lifecycle.COMMENT_ON_CANCEL_BY_APP));
  assert.equal(lifecycle.COMMENT_ON_CANCEL_BY_APP, 9, 'the legacy wire code the CRM history reads');
  // commented_by is a tbl_user FK; an efr id there renders some operator's name.
  assert.doesNotMatch(comment.sql, /commented_by/);
  assert.match(comment.sql, /efr_id/, 'the technician is identified by the column that types them');

  // The legacy implementation had its cancel WhatsApp commented out. Nothing
  // has been decided at request time, so there is nothing to tell anyone.
  assert.equal(waSends.length, 0, 'a cancel REQUEST must not notify anyone');
});

test('cancel survives an audit-write failure — the ask is already committed', async () => {
  failAudit = true;
  const out = await lifecycle.cancel(JOB_ID, EFR_ID, { reason: 'x', reasonId: 267 });
  assert.deepEqual(out, { requested: true, requestType: 'cancel' });
  // Positive control: the audit inserts were actually attempted and threw.
  assert.equal(fake.calls.filter((c) => /INSERT INTO tbl_easyfixer_call_record/i.test(c.sql)).length, 1);
  assert.equal(fake.calls.filter((c) => /INSERT INTO tbl_job_comment/i.test(c.sql)).length, 1);
});

test('cancel refuses another technician\'s job', async () => {
  ownedByEfr = EFR_ID + 1;
  await assert.rejects(
    () => lifecycle.cancel(JOB_ID, EFR_ID, { reason: 'x', reasonId: 267 }),
    (e) => e.status === 404,
  );
  assert.equal(jobUpdates().length, 0, 'nothing is written for a job the tech does not own');
});

// ═══════════════════════════ RESCHEDULE ════════════════════════════════════

test('reschedule NEVER moves the real appointment — the ask lands in the _app column', async () => {
  await lifecycle.requestReschedule(JOB_ID, EFR_ID, {
    newDate: '2026-05-06T17:30:00', reasonId: 263, remarks: 'customer asked',
  });
  const upd = oneJobUpdate();

  // POSITIVE CONTROL: this is the statement that writes the appointment ask,
  // so "requested_date_time is absent" is a claim about a statement that ran.
  assert.match(upd.sql, /reschedule_date_time_app = \?/);
  assert.doesNotMatch(upd.sql, /requested_date_time/,
    'a reschedule REQUEST must not move requested_date_time — only ops writes that');
  assert.match(upd.sql, /is_rescheduled_by_app = 1/);
  assert.equal(upd.params[0], lifecycle.STATUS_REQUEST_PENDING);
});

test('the requested slot is stored as IST wall-clock TEXT, unshifted', async () => {
  await lifecycle.requestReschedule(JOB_ID, EFR_ID, {
    newDate: '2026-05-06T17:30:00', reasonId: 263, remarks: null,
  });
  const stored = oneJobUpdate().params[1];
  // The column is VARCHAR: the value must be the exact wall clock the
  // technician picked. A JS Date here (or a new Date() round-trip) reads the
  // bare literal in the SERVER's zone — in the UTC container this suite runs
  // in, that is a silent 5h30m shift of the customer's slot.
  assert.equal(typeof stored, 'string');
  assert.equal(stored, '2026-05-06 17:30');
  assert.equal(stored.length, 16, 'yyyy-MM-dd HH:mm — minute precision, no seconds');
});

test('reschedule_reason_id is written only for a real reason, never for the 0 sentinel', async () => {
  await lifecycle.requestReschedule(JOB_ID, EFR_ID, { newDate: '2026-05-06T17:30', reasonId: 263 });
  assert.match(oneJobUpdate().sql, /reschedule_reason_id = \?/);

  fake.reset();
  await lifecycle.requestReschedule(JOB_ID, EFR_ID, { newDate: '2026-05-06T17:30', reasonId: 0 });
  const zero = oneJobUpdate();
  // 0 is the app's "nothing picked" sentinel, not reason #0 — writing it aims
  // the CRM's reason join at a row that does not exist.
  assert.doesNotMatch(zero.sql, /reschedule_reason_id = \?/);
  // …but the generic mirror is still written (as NULL), so the shape is stable.
  assert.match(zero.sql, /enum_reason_id = \?/);
});

test('reschedule_remarks / reschedule_at_app are stamped only when a comment was sent', async () => {
  await lifecycle.requestReschedule(JOB_ID, EFR_ID, {
    newDate: '2026-05-06T17:30', reasonId: 263, remarks: 'customer asked',
  });
  const withRemark = oneJobUpdate();
  assert.match(withRemark.sql, /reschedule_remarks = \?/);
  assert.match(withRemark.sql, /reschedule_at_app = \?/);

  for (const blank of [null, '', '   ']) {
    fake.reset();
    await lifecycle.requestReschedule(JOB_ID, EFR_ID, {
      newDate: '2026-05-06T17:30', reasonId: 263, remarks: blank,
    });
    const upd = oneJobUpdate();
    // Blank-stamping these would ERASE the remark from a previous ask that ops
    // has not looked at yet.
    assert.doesNotMatch(upd.sql, /reschedule_remarks = \?/, 'blank remark: ' + JSON.stringify(blank));
    assert.doesNotMatch(upd.sql, /reschedule_at_app = \?/, 'blank remark: ' + JSON.stringify(blank));
  }
});

test('reschedule still counts the push, and files a comment_on 8 audit row', async () => {
  await lifecycle.requestReschedule(JOB_ID, EFR_ID, { newDate: '2026-05-06T17:30', reasonId: 263 });

  assert.match(oneJobUpdate().sql, /resch_job_count = COALESCE\(resch_job_count, 0\) \+ 1/);

  const comment = oneMatching(/INSERT\s+INTO\s+tbl_job_comment/i);
  assert.ok(comment.params.includes(lifecycle.COMMENT_ON_RESCHEDULE_BY_APP));
  assert.equal(lifecycle.COMMENT_ON_RESCHEDULE_BY_APP, 8);
  assert.ok(comment.params.includes('2026-05-06 17:30'),
    'the comment carries the requested slot as the same wall-clock text');

  // Reschedule has no member of the call-record `action` enum, and legacy
  // never wrote one — so it must not invent a value that stores as NULL.
  assert.equal(fake.calls.filter((c) => /tbl_easyfixer_call_record/i.test(c.sql)).length, 0);
});

test('reschedule tells the Project Manager on WhatsApp, and nobody else', async () => {
  await lifecycle.requestReschedule(JOB_ID, EFR_ID, {
    newDate: '2026-05-06T17:30', reasonId: 263, remarks: 'customer asked',
  });
  assert.equal(waSends.length, 1, 'exactly one message: to the person who actions the ask');
  const sent = waSends[0];
  assert.equal(sent.to, PM_MOBILE);
  assert.ok(sent.templateName, 'a template name must be resolved — Gallabox 200s on an unknown one');
  // Positional keys, matching every non-enquiry template in this backend.
  assert.equal(sent.bodyValues[2], String(JOB_ID));
  assert.equal(sent.bodyValues[4], '2026-05-06 17:30');
  assert.equal(sent.bodyValues[5], 'Customer not responding');
  // Never an empty template variable — some BSPs drop the whole template.
  for (const v of Object.values(sent.bodyValues)) assert.notEqual(String(v).trim(), '');
});

test('no project manager on the job → no message, and the request still stands', async () => {
  pmRow = { pm_name: null, pm_mobile: null, technician_name: 'Ravi', customer_name: 'Asha', reason_desc: null };
  const out = await lifecycle.requestReschedule(JOB_ID, EFR_ID, { newDate: '2026-05-06T17:30', reasonId: 263 });
  assert.equal(waSends.length, 0);
  assert.deepEqual(out, { requested: true, requestType: 'reschedule', requestedDateTime: '2026-05-06 17:30' });
  // Positive control: the ask itself was written.
  assert.match(oneJobUpdate().sql, /is_rescheduled_by_app = 1/);
});

test('a WhatsApp failure never loses a committed request', async () => {
  gallabox.sendTemplate = async () => { throw new Error('gallabox unreachable'); };
  try {
    const out = await lifecycle.requestReschedule(JOB_ID, EFR_ID, { newDate: '2026-05-06T17:30', reasonId: 263 });
    assert.equal(out.requested, true);
  } finally {
    gallabox.sendTemplate = async (args) => { waSends.push(args); return { delivered: true }; };
  }
});

// ═══════════════════ THE bit(1) TRAP, BOTH SURFACES ════════════════════════
/*
 * is_cancelled_by_app / is_rescheduled_by_app are bit(1). mysql2 hands a BIT
 * back as a Buffer, and EVERY Buffer is truthy in JS — including the one
 * holding 0. Read or projected naively, every job in the system reports a
 * pending request. Both surfaces are pinned here because they answer the same
 * question and must not disagree.
 */

test('the LIST projection never emits a raw bit column', async () => {
  const cols = jobService.LIST_COLUMNS;
  // Positive control on the SCAN: the constant really is the projection and
  // really mentions the flags — otherwise the shape assertions below scan a
  // string that does not contain them and pass vacuously.
  assert.match(cols, /is_cancelled_by_app/);
  assert.match(cols, /is_rescheduled_by_app/);

  for (const flag of ['is_cancelled_by_app', 'is_rescheduled_by_app']) {
    assert.match(
      cols,
      new RegExp('\\(COALESCE\\(j\\.' + flag + ', 0\\) = 1\\)\\s+AS\\s+' + flag),
      flag + ' must be projected as a 0/1 comparison, not as the raw BIT',
    );
    assert.doesNotMatch(
      cols,
      new RegExp('(^|[^(])j\\.' + flag + ','),
      flag + ' must never be selected bare — a Buffer serialises as {"type":"Buffer"} and is truthy',
    );
  }
  // The rest of what the CRM buckets a pending request from.
  assert.match(cols, /j\.reschedule_date_time_app/);
  assert.match(cols, /j\.cancel_date_time/);
  assert.match(cols, /AS app_request_reason/);
  // The reason text must come from action_taken_reason — the bucket the app's
  // own reason lists are served from — not from the legacy per-table sources.
  assert.match(cols, /action_taken_reason[\s\S]*job_cancel_reason_id_by_easyfixer/);
  assert.match(cols, /action_taken_reason[\s\S]*reschedule_reason_id/);
});

test('buildAppRequest decodes the BIT, and a Buffer 0 is NOT a pending request', () => {
  const noRequest = jobService.buildAppRequest({
    is_cancelled_by_app: Buffer.from([0]),
    is_rescheduled_by_app: Buffer.from([0]),
  });
  assert.equal(noRequest, null, 'Buffer([0]) is truthy — decoding it wrongly flags every job');

  const cancel = jobService.buildAppRequest({
    is_cancelled_by_app: Buffer.from([1]),
    is_rescheduled_by_app: Buffer.from([0]),
    job_cancel_reason_id_by_easyfixer: 267,
    app_cancel_reason_name: 'Self installed by customer',
    cancel_date_time: '2026-04-29 10:20:58',
  });
  assert.deepEqual(cancel, {
    type: 'cancel',
    requestedDateTime: null,
    reasonId: 267,
    reason: 'Self installed by customer',
    requestedAt: '2026-04-29 10:20:58',
  });

  const resched = jobService.buildAppRequest({
    is_cancelled_by_app: Buffer.from([0]),
    is_rescheduled_by_app: Buffer.from([1]),
    reschedule_date_time_app: '2026-05-06 17:30',
    reschedule_reason_id: 263,
    app_reschedule_reason_name: 'Customer want a reschedule',
    reschedule_at_app: '2026-04-28 11:30:20',
  });
  assert.equal(resched.type, 'reschedule');
  assert.equal(resched.requestedDateTime, '2026-05-06 17:30');
  assert.equal(typeof resched.requestedDateTime, 'string',
    'the ask stays the stored wall-clock text — never re-parsed into a Date');

  // Both flags set: cancel wins, because it is the ask that stops work.
  const both = jobService.buildAppRequest({
    is_cancelled_by_app: Buffer.from([1]),
    is_rescheduled_by_app: Buffer.from([1]),
  });
  assert.equal(both.type, 'cancel');

  // Plain numbers (a driver configured without BIT buffering) decode too.
  assert.equal(jobService.buildAppRequest({ is_cancelled_by_app: 0, is_rescheduled_by_app: 0 }), null);
  assert.equal(jobService.buildAppRequest({ is_cancelled_by_app: 1 }).type, 'cancel');
});

// ═══════════════════════ THE REASON LISTS ══════════════════════════════════

test('the app reason lists are ONE query, discriminated only by action_type', async () => {
  const seen = [];
  for (const fn of ['appCancelReasons', 'appRescheduleReasons', 'cannotCompleteReasons']) {
    fake.reset();
    await lookup[fn]();
    const q = oneMatching(/FROM\s+action_taken_reason/i);
    seen.push({ fn, sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params });
  }
  // Positive control: the scan found three real statements.
  assert.equal(seen.length, 3);
  for (const s of seen) assert.match(s.sql, /action_type = \?/);

  // One query text, not three copies that drift.
  assert.equal(new Set(seen.map((s) => s.sql)).size, 1,
    'cannot-complete and app-reschedule share a row set — they must share the query too');

  /*
   * …and one query SITE, not three copies that happen to agree today. Same
   * text is what the runtime check above can see; a forked copy that starts
   * identical passes it and then drifts on the first edit to either. So this
   * reads the source: each of the three must DELEGATE, never issue SQL itself.
   */
  const svc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'services', 'lookup.service.js'), 'utf8',
  );
  let bodiesChecked = 0;
  for (const fn of ['cannotCompleteReasons', 'appRescheduleReasons', 'appCancelReasons']) {
    const m = svc.match(new RegExp('function ' + fn + '\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}'));
    assert.ok(m, 'could not locate ' + fn + ' in lookup.service.js');
    bodiesChecked++;
    assert.match(m[1], /return appActionReasons\(APP_REASON_ACTION_TYPE\./,
      fn + ' must delegate to the shared helper');
    assert.doesNotMatch(m[1], /pool\.query/,
      fn + ' must not carry its own copy of the reason query');
  }
  // Positive control: the regex above actually located three bodies. A scan
  // that matched nothing would satisfy every assertion inside the loop.
  assert.equal(bodiesChecked, 3);

  // Each function binds ITS constant — derived, so a renamed bucket cannot
  // make this assertion stale.
  const T = lookup.APP_REASON_ACTION_TYPE;
  assert.deepEqual(seen[0].params, [T.cancel, lookup.APP_REASON_USER_TYPE]);
  assert.deepEqual(seen[1].params, [T.reschedule, lookup.APP_REASON_USER_TYPE]);
  assert.deepEqual(seen[2].params, [T.cannotComplete, lookup.APP_REASON_USER_TYPE]);
  assert.notEqual(T.cancel, T.reschedule, 'cancel and reschedule are different buckets');
  assert.equal(T.reschedule, T.cannotComplete, 'these two legitimately share one bucket today');
  /*
   * …and the constants themselves are PINNED. Deriving alone would pass just
   * as happily if someone edited action_type to 8: the query and the
   * expectation would move together and the technician would silently get the
   * operator's list. These three numbers were verified against the live table
   * (27 → 5 rows, 26 → 7 rows, user_type 4 = Technician) and are the whole
   * definition of which reasons the app offers.
   */
  assert.equal(T.cancel, 27);
  assert.equal(T.reschedule, 26);
  assert.equal(lookup.APP_REASON_USER_TYPE, 4);

  // The legacy active filter, and the user_type that keeps the list to the
  // five a technician may pick rather than every reason anyone may pick.
  assert.match(seen[0].sql, /user_type = \?/);
  assert.match(seen[0].sql, /status = 1/);
  assert.match(seen[0].sql, /is_new = 1/);
});

test('each surface gets its own endpoint name, and the CRM lists are untouched', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'shared', 'lookup.js'), 'utf8',
  );
  const paths = [...src.matchAll(/router\.get\('(\/[a-z0-9-]+)'/g)].map((m) => m[1]);
  // Positive control: the scan parsed a real route table.
  assert.ok(paths.length > 10, 'expected the shared lookup route table, parsed ' + paths.length);

  for (const p of ['/app-cancel-reasons', '/app-reschedule-reasons']) {
    assert.ok(paths.includes(p), 'missing app reason endpoint ' + p);
  }
  // The CRM's own lists keep their names and their (different) sources — the
  // Schedule & Assign and Cancel dialogs already consume them.
  for (const p of ['/cancel-reasons', '/reschedule-reasons', '/cannot-complete-reasons']) {
    assert.ok(paths.includes(p), 'the CRM list ' + p + ' must not be renamed away');
  }
  /*
   * Distinct CACHE KEYS too, for every route in the file. Two surfaces sharing
   * a key is invisible until the day their row sets diverge, and then whichever
   * one is requested first silently answers for both — for the whole TTL, with
   * no error anywhere. Checked across the file rather than for the new pair
   * alone: the collision is a property of the key namespace.
   */
  const keys = [...src.matchAll(/cached\('([^'$]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 10, 'expected the cached lookup keys, parsed ' + keys.length);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dupes, [], 'two lookup routes share a cache key: ' + dupes.join(', '));
  assert.ok(keys.includes('lookup:app-reschedule-reasons'));
  assert.ok(keys.includes('lookup:app-cancel-reasons'));
});
