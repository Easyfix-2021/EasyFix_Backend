---
name: code-review
description: "Reviews a diff against EasyFix_Backend's real conventions and gates. Use for 'review', 'check this code', 'PR review'."
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git rev-parse:*), Bash(npm run:*), Bash(node scripts/:*)
---

Review $ARGUMENTS against **EasyFix_Backend**.

> Every claim below was verified against this repository on 2026-09-08. If one
> stops holding, fix it here — a scoped skill outranks the general one, so a
> wrong claim in this file is worse than no claim. Do not add a rule you have
> not checked against the tree.

## The diff to review

Feature work lands on `HotFix`; `QA` and `Production` are the deploy branches
(`.github/workflows/deploy.yml` triggers on pushes to those two). The unit under
review is everything above the deploy branch, not one commit — `HEAD~1` is only
ever right by accident.

!`git rev-parse origin/Production; git diff --name-only origin/Production...HEAD; git status --short`
!`git diff origin/Production...HEAD`

Pin that SHA and quote it in the report. `origin/Production` moves — someone
pushing the branch under review to it mid-review empties the diff, which reads
as a clean tree. Re-diff against the SHA, not the ref, if anything looks empty.

## Run the gates first

```
npm run lint     # no-undef + no-use-before-define. NOT style: every rule is
                 # "this line throws at runtime". Two production 500s came from
                 # exactly these — see the eslint.config.mjs header.
npm run build    # node --check sweep. Syntax only.
npm test         # scripts/test-no-skips.js — a SKIPPED test counts as FAILED.
npm run check:offline                          # /api/mobile idempotency contract
node scripts/scan-unguarded-await.js --self-test && \
node scripts/scan-unguarded-await.js --gate
node scripts/scan-catch-shape.js               # census, always exits 0 — read it
```
`verify:schema`, `verify:phantom-columns`, `verify:scope-predicates`,
`verify:migrations`, `check:migrations`, `check:sections` need a DB; run those
covering what the diff touched.

## Highest-value check: where the `await` sits

Express 4 attaches no `.catch` to an async handler's promise. An `await`
**outside** the handler's `try` rejects into nothing: the request hangs, and
before `server.js` grew an `unhandledRejection` listener the process exited.
That is the 2026-09-08 outage — post-mortem in `utils/async-middleware.js`.
House shape, ~826 handlers deep:

```js
router.get('/x', async (req, res, next) => {
  try { ...every await... ; modernOk(res, data); } catch (e) { next(e); }
});
```
- Every `await` inside the `try`; `scan-unguarded-await.js --gate` enforces it.
- Any `async` **middleware** must be wrapped in `asyncMiddleware()`.
- Handlers do **not** build their own 500 — `next(e)` reaches
  `middleware/error-handler.js`, which logs and picks the right envelope.
- Watch what a `catch` assumes: `next(e)` with a falsy `e` reads to Express as
  "no error", falls through to the 404 handler, logs nothing, and is
  indistinguishable from success. `scan-catch-shape.js` censuses this.

## Two response envelopes — mixing them breaks an external contract

`modernOk`/`modernError` from `utils/response.js` (`{success, data|error}`)
everywhere **except `/api/integration/v1/*`**, which uses `legacyOk`/
`legacyError` → `{status:"200", message, data}` with `status` a **STRING**,
dates `"DD-MM-YYYY HH:mm"` never ISO, and HTTP Basic auth. External clients must
see zero difference — root `CLAUDE.md`, NO-CLIENT-CHANGE RULE. `error-handler.js`
and `middleware/validate.js` already branch on the prefix; never bolt a global
envelope onto these routes.

## Guards

`routes/admin/index.js` mounts `requireAuth` → `role(['admin'])` → mask/scope for
the whole group, so a new sub-router inherits them. Per-endpoint gates that
exist in `middleware/`: `require-action.js` (`requireAction('isJobMagicLinkSend')`,
59 call sites, keyed off `menu_action`/`role_menu_action`), `require-stage.js`,
`require-property-allowlist.js`, `require-quicksight.js`, `basic-auth.js`
(integration v1), `client-auth.js`, `tech-auth.js`, `roleByName` in `role.js`.
Auth is this backend's own OTP-issued JWT — no SSO, no shared session.

## Cron — `server/scheduler.js`

- 22 jobs, all `{ timezone: 'Asia/Kolkata' }`. A new one without it is a finding.
- **Re-entrancy**: node-cron defaults to `noOverlap=false`. Register through the
  file's own wrapper so the `job.running` guard applies — a tick outliving its
  interval otherwise stacks a second run and doubles pool demand.
- Ops-flippable flags live in **`easyfix_properties`** via
  `services/properties.service.js` (1h TTL cache; `POST /api/admin/properties/reload`
  flushes it), not in env vars.

## SQL and dates

- Parameterised `?` only. One pool, `db.js` at the repo **root**.
- Multi-step writes: `beginTransaction/commit/rollback`, release in `finally`.
- Count **peak simultaneous acquires**, not statements: `connectionLimit: 30`,
  `queueLimit: 50`, so a data-driven `Promise.all` can starve the process. See
  the `sql-optimize` skill.
- New/renamed columns → `npm run verify:phantom-columns`; SQL naming a column
  that does not exist passes lint, build and most tests.
- City scope must go through `lib/scope.js::cityScopeSql`
  (`npm run verify:scope-predicates`); a hand-rolled `IN (…)` drops NULL cities.
- **Dates are already IST.** `db.js` sets `dateStrings: true, timezone: '+05:30'`,
  so a DATETIME returns as an IST wall-clock string and `new Date()` writes IST
  verbatim. Adding an IST offset on the way out double-shifts; swapping to `NOW()`
  to "fix" a timezone bug changes the value. Reject both.
- `typeCast` maps TINYINT(1)/BIT(1) to real booleans — comparing to `1`/`'1'` is
  a bug, not a style choice.

## General

1. No secrets in code. No `console.log` (0 today across routes/services/
   middleware/utils/lib) — lint does **not** enforce it, so this is on you.
2. Joi via `middleware/validate.js` on every body; server-side pagination
   (`LIMIT ?, ?`) with a `.max()` on the limit.
3. Never `ALTER` a shared legacy table — five services share `easyfix_core`.
4. `shared/wire-contract.json` is byte-duplicated in `Easyfix_CRM_UI`: change
   both, run `npm test` in both.

Rate: CRITICAL | WARNING | SUGGESTION. Cite `file:line`. If you could not run a
gate, say so — never report a check you did not execute.
