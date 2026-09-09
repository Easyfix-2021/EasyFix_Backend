---
name: perf-review
description: "Performance review for EasyFix_Backend — pool concurrency, API latency, cron efficiency, file/export memory. Use for 'make it faster', 'slow', 'performance', 'optimize', 'pool exhausted'."
allowed-tools: Read, Grep, Glob, Bash
---

Analyze $ARGUMENTS for performance bottlenecks in **EasyFix_Backend**.

> Every fact below was verified against this repository on 2026-09-08. If you find
> one that no longer holds, fix it here — a scoped skill is preferred over the
> general one, so a wrong claim in this file outranks a right one elsewhere.
> Do not add a rule you have not checked against the tree.

**Division of labour with `/sql-optimize`**: that skill owns SQL — indexes,
EXPLAIN, sargability, query-level traps. This one owns *what to measure, in what
order*, and the non-SQL surfaces. Don't restate its rules here.

## Start by counting acquires, not queries

This is the EasyFix-specific thing, and it caused a production outage on
2026-09-08. One `mysql2` pool in `db.js` (repo ROOT) serves all HTTP traffic
**and** the in-process cron scheduler: `connectionLimit: 30`, `queueLimit: 50`,
both env-overridable — so the **81st simultaneous acquire in the process** throws
`Queue limit reached.` to *every* caller.

Measured (`docs/schedule-assign-explain-and-indexes.sql`): one Schedule & Assign
open issues **43 statements at a peak of 16 simultaneous acquires**, held for the
whole call, and **no statement used `type=ALL`**. Two concurrent opens fill the
pool; six exceed the 80 ceiling. The frame that reports the error is whatever
queries most often — usually the per-request auth lookup — so **the reporting
query is the victim, not the cause**, and query time was never the problem.

So: **"parallelize sequential queries with `Promise.all()`" is the wrong default
here.** An unbounded `Promise.all` over DB work costs N connections *at once* and
is the documented cause of that outage. The rule:

- A `Promise.all` of **fixed, small width** is fine — the 9-way one in
  `services/mobile-dashboard.service.js` (~15 queries) is why the limit is 30.
- A fan-out whose width comes from **data or a request body** is a finding — one
  caller can take the whole pool. Bound it (Joi `.max()`) *and* chunk it.
- A wide fan-out on a **hot** path needs a module-level bulkhead, not a per-call
  cap: `STATS_QUERY_CONCURRENCY` in `services/candidate-ranking.service.js`
  (default 12, `RANKING_STATS_CONCURRENCY`), asserted by
  `tests/ranking-pool-bulkhead.test.js`.
- Serialising is a legitimate fix. Slower endpoint, process stays up.

## How to measure it

- **Peak concurrency**: wrap `pool.query` to record every statement, call the
  service, and sample `db.js`'s `_readLiveGauges()` in parallel — that pairing
  produced the numbers above. The same gauges back `poolSaturation()` on
  `/api/health` and `/api/health/db`; alert on `status === 'saturated'`.
- **Wall time**: every request is already timed — `middleware/http-log.js` prints
  `(NNN ms)` on each access line. For a phase inside a handler the house idiom is
  `const t0 = Date.now()` … `logger.info('… ' + (Date.now() - t0) + 'ms')`
  (`routes/admin/jobs.js` export, `services/*-cron.js`).
- **Never `console.time`/`console.log`.** Zero exist in `routes/`, `services/` or
  `middleware/` (163 hits repo-wide are all `scripts/`, `tests/` and `logger.js`
  itself). Note the linter does **not** enforce this — `eslint.config.mjs`
  deliberately omits `no-console`; it is a CLAUDE.md rule kept by review.

## Cron

There is no leave-credit or cycle-end cron. `server/scheduler.js` has 22
`cron.schedule` sites on `Asia/Kolkata`, most in a registry whose
`runner`/`tester` telemetry drives the Scheduled Jobs admin page. When reviewing:

- **Overlap is already guarded**: `invokeJob()` skips a `kind === 'cron'` tick
  while `job.running` (manual triggers stay exempt). Don't re-add a guard; do
  check a new job goes through `invokeJob` rather than calling `cron.schedule`
  with a bare closure.
- Cron work competes with HTTP traffic for the same 30 connections — a batch
  loop in a cron is safer than a fan-out for exactly that reason.
- Gates are real: `CRON_DISABLED`, plus per-job env/property gates that leave a
  job registered-but-skipped. A "slow cron" may simply not be running.

## Files, PDFs and exports

- **Uploads**: every route uses `multer.memoryStorage()` with an explicit
  `limits.fileSize` (2–10 MB). S3 writes are a single `PutObject` from that
  buffer (`utils/s3-storage.js`). `@aws-sdk/lib-storage` is not a dependency and
  multipart upload is not applicable at these sizes — the cap is the control.
- **PDFs** (`pdfkit`, real): `utils/pdf-certificate.js` and `utils/pdf-invoice.js`
  stream straight into `res` — keep it that way. Trap: once
  `renderCertificatePdf({ stream: res })` starts piping the status line is
  already sent, so a mid-render throw cannot become a 500.
- **`sharp`** (real, one runtime site): rasterises the certificate frame at
  `density: 300` in `utils/pdf-certificate.js`. CPU-bound on the single Node
  thread — the thing to watch, not S3 resize.
- **Big exports**: `utils/xlsx-stream-export.js` is the constant-memory streamer
  (commit per row); `utils/xlsx-styled-export.js` buffers the whole workbook and
  is for ~200-row reports only. Picking the wrong one is the memory bug.

## Already solved — don't reinvent

- Pagination is server-side `LIMIT ?, ?` (CLAUDE.md rule; 49 files). A list
  endpoint without it is a finding — and cap the page size in the Joi schema.
- `utils/ttl-cache.js` is the in-process cache for lookups/menus (10 call sites).
- `compression({ threshold: 1024 })` is already mounted in `server.js`.

## Output format

| Priority | Area | Issue | Fix | Measurement that proves it |
|----------|------|-------|-----|----------------------------|

State peak acquires before/after, or ms before/after. Say what you could not
measure and why, rather than estimating a speedup.
