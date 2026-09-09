/*
 * Pool sizing, in ONE place.
 *
 * Split out of db.js because the value has two readers that must agree and
 * cannot share the module: db.js itself, and tests/ranking-pool-bulkhead.test.js,
 * which REPLACES `../db` in require.cache with a fake pool before requiring the
 * service under test. Anything exported from db.js is invisible there, so the
 * test kept its own `|| '30'` copy — and that copy silently went stale when
 * db.js moved on, in the safe direction, so nothing ever complained.
 *
 * This module is never stubbed, so both readers resolve the same number.
 *
 * These are FALLBACKS. Production sets DB_CONNECTION_LIMIT in the host env and
 * that wins — on 2026-09-09 it was running 50/100 while this repo said 30/50.
 * Ask the process, not the source: GET /api/health/db.
 */
const DEFAULT_CONNECTION_LIMIT = '100';
const DEFAULT_QUEUE_LIMIT = '150';

const poolLimit = () => parseInt(process.env.DB_CONNECTION_LIMIT || DEFAULT_CONNECTION_LIMIT, 10);
const poolQueueMax = () => parseInt(process.env.DB_QUEUE_LIMIT || DEFAULT_QUEUE_LIMIT, 10);

module.exports = { DEFAULT_CONNECTION_LIMIT, DEFAULT_QUEUE_LIMIT, poolLimit, poolQueueMax };
