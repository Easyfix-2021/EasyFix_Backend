'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SCHEDULER = fs.readFileSync(path.join(__dirname, '..', 'server', 'scheduler.js'), 'utf8');

/*
 * The Scheduled Jobs "Test" modal had exactly one shape: a mandatory mobile
 * number plus an optional row id, because the first three testable jobs all
 * dispatched a WhatsApp. Every job registered since inherited that form.
 *
 * Six of the nine jobs with a tester never look at `mobile` — they run the
 * job's real work for one row. Those six demanded a phone number, discarded
 * it, mislabelled their required row id as "(optional)", and displayed a
 * safety notice about a message that is never sent. One of them worked around
 * the forced field by naming it "Not required", which is the clearest possible
 * signal that the form was wrong rather than the job.
 *
 * `testKind` makes the job declare what its test does, and the modal and the
 * route both take their shape from that.
 */

test('every tester that ignores mobile declares itself an action', () => {
  /*
   * Derived from the tester SIGNATURE, not from a hand-kept list. A new job
   * whose tester takes only { sourceId } fails here until it declares its
   * kind — which is what stops the form from silently going wrong again.
   */
  const lines = SCHEDULER.split('\n');
  const misdeclared = [];

  lines.forEach((line, i) => {
    const m = /^\s*tester: (.*)$/.exec(line);
    if (!m || /tester \|\| null/.test(m[1])) return;
    const usesMobile = /mobile/.test(m[1]);
    // The declaration sits within a couple of lines of the tester.
    const near = lines.slice(i, i + 4).join('\n');
    const declaresAction = /testKind: 'action'/.test(near);
    if (usesMobile === declaresAction) {
      misdeclared.push(`line ${i + 1}: ${m[1].trim()}`);
    }
  });

  assert.deepEqual(misdeclared, [], 'a tester that ignores mobile must declare testKind: action, and vice versa');
});

test('the shape is declared per job, and defaults to the old behaviour', () => {
  assert.match(
    SCHEDULER,
    /testKind: testKind === 'action' \? 'action' : 'message'/,
    'an undeclared job must stay message-shaped, which is what every caller assumed before',
  );
  assert.match(SCHEDULER, /testKind: j\.testKind,/, 'the shape must reach the CRM or the modal cannot use it');
});

test('mobile is required only where a message is actually sent', () => {
  const guard = SCHEDULER.slice(
    SCHEDULER.indexOf('function testJob('),
    SCHEDULER.indexOf('function testJob(') + 2500,
  );
  assert.match(
    guard,
    /job\.testKind === 'message' && !String\(input\.mobile \|\| ''\)\.trim\(\)/,
    'a message test must still refuse to run without a destination',
  );
  assert.match(
    guard,
    /job\.testKind === 'action' && job\.testSourceLabel/,
    'an action test must refuse to run without the row it will act on',
  );
});

test('the row id is required for an action, which is the opposite of a message', () => {
  /*
   * The polarity swap is the point. For a message the id only borrows real
   * content into the text, so blank means "use dummy details". For an action
   * the id IS the input — blank would mean "run the nightly job by hand",
   * which is what Trigger Now is for.
   */
  const validator = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'admin', 'scheduled-jobs.js'), 'utf8',
  );
  assert.match(
    validator,
    /mobile: Joi\.string\(\)[\s\S]{0,120}\.optional\(\)/,
    'the shared body schema cannot know which jobs need a mobile, so it must not demand one',
  );
  assert.match(
    validator,
    /req\.body\.mobile == null \? null : String\(req\.body\.mobile\)/,
    'an absent mobile must stay absent — String(undefined) would satisfy the message guard',
  );
});

test('positive control — the signature scan can actually fail', () => {
  /*
   * The first test passes trivially if the scan matches no testers at all,
   * which is how a regex that silently stopped matching would look identical
   * to a clean result.
   */
  const testers = SCHEDULER.split('\n')
    .filter((l) => /^\s*tester: /.test(l) && !/tester \|\| null/.test(l));
  assert.ok(testers.length >= 8, `expected the scan to find the registered testers, found ${testers.length}`);
  assert.ok(
    testers.some((l) => /mobile/.test(l)),
    'positive control: at least one message-sending tester must exist',
  );
  assert.ok(
    testers.some((l) => !/mobile/.test(l)),
    'positive control: at least one action tester must exist',
  );
});
