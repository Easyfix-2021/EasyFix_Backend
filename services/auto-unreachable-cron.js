/*
 * AUTO-UNREACHABLE SWEEP — the cron half of services/auto-unreachable.service.js.
 *
 * Kept thin on purpose: the rule, the predicate and the write all live in the
 * service, so the "Trigger Now" button on the scheduler page and the scheduled
 * run execute one implementation.
 *
 * DEFAULT-OFF, and this one earns the gate. The sweep WRITES to job history and
 * moves jobs into "Pending Action from Client", which is a claim the client sees
 * about their own customer. Ops turns it on deliberately, after looking at what
 * a dry run would have marked.
 */
const { pool } = require('../db');
const logger = require('../logger');
const { getProperty } = require('./properties.service');
const autoUnreachable = require('./auto-unreachable.service');

const FLAG = 'job.auto_unreachable.enabled';

function autoUnreachableEnabled() {
  return String(getProperty(FLAG) || '').toLowerCase() === 'true';
}

async function runAutoUnreachable() {
  // Re-checked here as well as at registration, so Trigger Now is a no-op while
  // the flag is off — the same contract every other gated cron in this file set
  // keeps.
  if (!autoUnreachableEnabled()) {
    logger.info(`Auto-unreachable sweep skipped — ${FLAG} is not 'true'`);
    return { skipped: true, reason: `${FLAG} not true`, marked: 0, eligible: 0 };
  }
  return autoUnreachable.sweep(pool);
}

module.exports = { FLAG, autoUnreachableEnabled, runAutoUnreachable };
