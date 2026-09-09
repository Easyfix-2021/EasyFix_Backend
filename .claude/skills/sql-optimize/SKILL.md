---
name: sql-optimize
description: "Optimizes MySQL queries and DB access patterns in EasyFix_Backend. Use for 'slow query', 'optimize SQL', 'DB performance', 'N+1', 'missing index', 'pool exhausted'."
allowed-tools: Read, Grep, Glob, Bash
---

Analyze $ARGUMENTS for MySQL performance issues in **EasyFix_Backend**.

> Every fact below was verified against this repository on 2026-09-08. If you find
> one that no longer holds, fix it here — a scoped skill is preferred over the
> general one, so a wrong claim in this file outranks a right one elsewhere.
> Do not add a rule you have not checked against the tree.

## Where things are

- **One pool**, `db.js` at the repo ROOT — not nested under a subdirectory.
  `mysql2/promise`, raw parameterised SQL, no ORM. `pool.query()` for one-offs;
  `pool.getConnection()` + `try/finally { conn.release() }` for transactions.
- **Migrations**: `migrations/` = pending, `migrations/executed/` = applied and
  frozen. Never move a file back. House pattern for index DDL:
  `ALGORITHM=INPLACE, LOCK=NONE` (see `migrations/executed/2026-08-10-index-job-offer-mobile-latest.sql`).
- **~186 files** under `services/` and `routes/` issue SQL.
- `db-read.js` is a replica-preferring read pool that is **deliberately unwired** —
  nothing calls `readQuery()`. Do not "optimise" by routing reads through it
  without reading that file's header first.

## Concurrency is the scarce resource, not query time

This is the EasyFix-specific thing to internalise, and it caused a production
outage on 2026-09-08.

`connectionLimit: 30`, `queueLimit: 50` (`db.js`, both env-overridable) — so the
**81st simultaneous acquire in the process throws `Queue limit reached.`** to
every caller, not just the greedy one. One pool serves all HTTP traffic *and* the
in-process cron scheduler.

Measured: one Schedule & Assign open peaks at **16 simultaneous acquires** held
for the whole call. Two concurrent opens fill the pool; **six exhaust it**. The
frame that reports the error is whatever queries most often — usually the
per-request auth lookup — so **the reporting query is the victim, not the cause.**

Therefore, when reviewing:

- Count a request's **peak simultaneous acquires**, not its statement count. A
  `Promise.all` over N queries costs N connections at once.
- Any `Promise.all` whose width is driven by **data or a request body** is a
  finding: one caller can then take the whole pool. Bound it with `.max()` in the
  Joi schema *and* chunk the fan-out (`routes/admin/finance.js` bulk-ops-approve).
- A wide fan-out on a hot path needs a **module-level bulkhead**, not a per-call
  cap — a per-call cap still lets N callers contribute N×cap. Reference
  implementation: `STATS_QUERY_CONCURRENCY` in `services/candidate-ranking.service.js`.
- **Never hold a pooled connection across non-DB work** — S3, an outbound HTTP
  call, an LLM call, a sleep. Hold time multiplies demand.
- Acquiring a **second** connection while holding one converts one slot of demand
  into two and pins the first for the second's unbounded wait (mysql2 has no
  acquire timeout).

Live gauges are on `/api/health` and `/api/health/db` (`poolSaturation()` in
`db.js`): alert on `status === 'saturated'`.

## Indexes

**Measure before proposing one.** `tbl_job` (~491k rows) already carries **29
indexes**, and `migrations/executed/2026-05-06-candidate-ranking-indexes-and-defaults.sql`
explicitly declined to add another because write cost on the hottest table is
real. That objection is legitimate — and answerable:

- **Prefer REPLACE over ADD.** A B-tree on `(a,b,c)` serves every query an index
  on `(a)` or `(a,b)` can. `tbl_job` has three indexes sharing the
  `(fk_easyfixter_id, job_status)` prefix, so one of them is already redundant.
  Replacing keeps the index count flat.
- **Selectivity decides it.** Of the rows the existing index hands the engine,
  what fraction survives the residual filter? Small ⇒ the column belongs in the
  index; large ⇒ pure write cost. Measure it **without sampling** — see
  `docs/schedule-assign-explain-and-indexes.sql` §2, which documents three
  sampled attempts that each returned a confident, wrong number.
- **QA cannot answer index questions.** It is a stale restore (newest `tbl_job`
  row weeks old, ~45 rows inside a 90-day window). Any recency-filtered
  measurement there measures the restore's age. Use a prod replica or say
  "not measured".

## Sargability — the rule, with the measurement

Keep the function on the **value** side. Proven on this schema against
`idx_job_efr_status_checkin (fk_easyfixter_id, job_status, checkin_date_time)`:

| predicate | key parts | rows |
|---|---|---|
| `col >= DATE_SUB(NOW(), INTERVAL 90 DAY)` | 3 (`key_len` 16) | **2** |
| *(no date predicate)* | 2 (`key_len` 10) | 1253 |
| `DATE(col) >= CURDATE()` | 2 (`key_len` 10) | 1253 |

So `DATE(col)`, `TIME(col)`, `YEAR(col)` and `LIKE '2026-04%'` on a DATETIME all
discard every key part after the column. Use a half-open range.

## Traps that have actually bitten this codebase

- **`COALESCE(?, col)` guards NULL only** — an empty string OVERWRITES the column.
  Used in ~25 files, so check the validator allows `''` through before trusting it.
- **`NOT IN (<subquery>)` returns nothing if the subquery yields one NULL.** Add
  `IS NOT NULL` inside it.
- **A `COUNT(*)` companion query needs the same joins as the main query** whenever
  the WHERE references a joined alias, or it 500s.
- **Dates are IST wall-clock by driver config** — `dateStrings: true`,
  `timezone: '+05:30'`, so `new Date()` writes IST verbatim. Do NOT "fix" a
  timezone bug by swapping to `NOW()`.
- **`typeCast` maps TINYINT(1)/BIT(1) to real booleans.** Several tables depend on
  it; comparing against `1`/`'1'` in JS is a bug, not a style choice.
- **Never ALTER shared legacy tables** beyond adding an index (see the root
  `CLAUDE.md`) — five legacy services share this database.

## Tools that already exist — use them before writing your own

```
npm run verify:schema            npm run verify:phantom-columns
npm run verify:scope-predicates  npm run verify:migrations
npm run check:migrations         npm run check:sections
```

`docs/export-explain-and-indexes.sql` and
`docs/schedule-assign-explain-and-indexes.sql` hold EXPLAIN packs and index
findings for the two heaviest surfaces — read the relevant one before re-deriving.

To profile a real request: wrap `pool.query` to record every statement, call the
service, then EXPLAIN each captured statement — and sample `db.js`'s
`_readLiveGauges()` in parallel for peak concurrency. Statement count alone hides
the number that matters.

## Output format

Original query → optimised query → **the measurement that justifies it** (EXPLAIN
before/after with `key`, `key_len`, `rows`; or peak acquires before/after). State
what you could not measure and why, rather than estimating a speedup.
