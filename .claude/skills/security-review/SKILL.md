---
name: security-review
description: "Security audit for EasyFix_Backend — auth surfaces, authorization, SQL injection, PII exposure, upload/secret handling. Use for 'security check', 'is this secure', 'vulnerability scan'."
allowed-tools: Read, Grep, Glob, Bash
---

Scan $ARGUMENTS (or recent changes) for security defects in **EasyFix_Backend**.

> Every fact below was verified against this repository on 2026-09-08. This repo has
> no frontend, so no browser-side rule (XSS, CSP, client-visible env vars) belongs
> here. A scoped skill
> outranks the general one — do not add a rule you have not checked against the tree.

## Auth: SIX distinct surfaces, six different guards

There is **no SSO shared with 1Office** here (root `CLAUDE.md`, "EasyFix is a
standalone product" — no Suite validate-token call, no `{slug}_auth_token`). Tokens are this backend's own: `utils/jwt.js` signs and verifies with
HS256 against `JWT_SECRET` — never the legacy Java secret `"esyfixsecret"`, so
legacy CRM bearers do not authenticate. `signUserToken` claims are
`{sub, email, role, name}`, `sub` = `tbl_user.user_id` as a string, 30d
(`JWT_EXPIRY`). Tokens are issued only by the OTP flow (`services/auth.service.js`);
`tbl_user` has no password column.

| Surface | Guard | Principal / store |
|---|---|---|
| `/api/admin`, `/api/shared` | `middleware/auth.js` | numeric `sub` → `tbl_user` |
| `/api/mobile` (technician) | `middleware/tech-auth.js` | `sub` = `efr:<id>` → `tbl_easyfixer` |
| `/api/client` (SPOC) | `middleware/client-auth.js` | `sub` = `spoc:<id>`; also gates `client_status = 1` |
| `/api/integration/v1/*` | `middleware/basic-auth.js` | HTTP Basic → `tbl_client_user`, falling back to `tbl_client_website` |
| `/api/public/*` | per-endpoint token verifiers in `utils/jwt.js` | magic links: `job_completion`, `job_feedback`, `job_share`, `easyfixer_profile_update`, `estimate_approval` |
| `/api/internal/*` | shared-secret header, timing-safe | `X-Internal-Resolve-Secret` vs `INTERNAL_IMAGE_RESOLVE_SECRET` |

`/api/webhook/*` has **no shared guard** — each sub-router authenticates itself
(Plivo signed `t` param, `STT_OOM_WEBHOOK_KEY` header). Check the sub-router, not
the mount.

**Magic-link tokens pin their `type` claim and reject every other type** — a leaked
feedback link must not replay against the completion endpoint, so a new public flow
that reuses an existing `sign*Token` rather than minting its own type is a finding.
Expiry alone is not enough: `requireUnconfirmedJob()` is the state-bound second layer.

## Authorization — four stacked layers, all real

`checkScreenAccess(screenId, actionId)` **does not exist in this repository** (the
only hits are in these skill files). The actual layers, all in `middleware/`:

1. `role(['admin'|'client'|'mobile'])` — group guard over `ROLE_ID_TO_GROUP`
   (`services/role.service.js`); unmapped roles fail closed. `roleByName(['Finance'])`
   for exact-name ACL inside a group.
2. `requireAction('isXxx')` — per-action grant from `role_menu_action` JOIN
   `menu_action`. Never hand-roll `req.user.permissions?.actionPermissions` inline;
   that pattern silently evaluated to `[]` before this middleware existed.
3. `requirePropertyAllowlist('access.x.emails')` — CSV-of-emails in
   `easyfix_properties`, matched on `official_email`. Fails CLOSED on empty/missing.
   Not grantable via Manage Role; that is the point.
4. `requireStageForTransition(kind)` — Job Stage Access. **Route layer only**; it
   must never appear inside `services/job.service.js` (technicians share those
   functions and carry no stage grants). Needs `scopedJob` to have run first.
   `requireQuicksight('isQuickSight<Report>View')` gates each native report.

**Horizontal access control is `lib/scope.js`, not a role check.** `/api/admin`
attaches `req.scope` once per request; row queries filter through `cityScopeSql()`
and by-id lookups call `assertEntityInScope()`. A new admin `/:id` route that omits
the scope check is an IDOR even though `role(['admin'])` passed. `npm run
verify:scope-predicates` is a default-deny static scan for exactly this — run it.

## SQL injection: the surface is ORDER BY, not the WHERE clause

Values are parameterised everywhere (`mysql2/promise`, no ORM). Identifiers cannot
be, so **24 sites in 20 files interpolate `ORDER BY ${...}`**. Every one checked
resolves the user's `sortBy` through a frozen whitelist map (`SORTABLE_COLUMNS` /
`SORT_MAP` / `MAIN_SORT`) with a hardcoded default, and direction is normalised to
the literal `ASC`/`DESC`. A new sort column must be added to the map **and** to the
Joi validator (`.valid(...Object.keys(SORTABLE_COLUMNS))`) — the map alone permits
an unvalidated key to fall through to the default silently.
`LIMIT ${...}` appears 39 times and every one is a module-level constant, not input.

## PII: technicians, customers and client contacts — not employees

- **Encrypted at rest** via `lib/field-crypto.js` (`encryptField`/`decryptField`,
  AES-256-GCM envelope under `EASYFIX_FIELD_ENC_KEY`): payout `account_number` and
  `account_name` (`services/profile-self.service.js`), and `pan` / `aadhaar` on
  `tbl_user_personal_details` (`services/user.service.js`). There is no separate
  encryption utility module anywhere else in the tree — field-crypto is it.
- **Masked on read, never decrypted for display**: PAN/Aadhaar come back only as
  `pan_masked` / `aadhaar_masked` derived from clear `*_last4` columns. Plaintext is
  reachable only through `scripts/field-recover.js` with a key the servers do not hold.
- **Mobile numbers** are masked response-wide by `middleware/mask-mobile.js` on all
  of `/api/admin`, with `?unmasked=true` and a `UNMASKED_PATH_PREFIXES` list (staff
  directory only) as the opt-outs. `middleware/reject-masked-mobile.js` 400s a masked
  value coming back in a body — without it, bullets overwrite the real digits.
  Neither applies to `/api/integration/v1/*` or `/api/webhook/*`, by contract.
- **Logs**: `logger.js` renders every key with no redaction, so a raw mysql2
  `ER_DUP_ENTRY` (message embeds the rejected value) must never reach the logger —
  see `utils/aadhaar-uniqueness.js`. URLs *are* scrubbed by `redactUrl()` in
  `utils/log-format.js` (Aadhaar, PAN, Indian mobile, 24+ char base64url token).

## Error responses

`middleware/error-handler.js` is correct and is the model: 5xx collapses to
`"Internal Server Error"`, `err.code` reaches the client only via
`safePublicErrorCode()` (4xx only, allowlisted shape, `ER_*`/`ERR_*`/`E*` refused),
and the logged URL goes through `redactUrl`. A route that builds its own error body
and echoes `err.message` on a 500, or puts a DB error into `details`, bypasses all
of it.

## Uploads and S3

Every upload uses `multer.memoryStorage()` with an explicit `limits.fileSize`
(2–25 MB by route); several add `fileFilter`. Keys in `utils/s3-storage.js` are
**server-derived, never user-supplied**: `keyFor(jobId, seq, {category})` validates
positive integers and a PascalCase-only category; `buildNoticeKey()` discards
`originalName` and uses `Date.now()`+random. Filenames survive only in object
metadata, stripped to printable ASCII, truncated to 200 chars. Presigned GETs default
to **300 s** (`S3_PRESIGN_TTL_SEC`), notices 3600 s (`S3_NOTICE_PRESIGN_TTL_SEC`).

## Platform controls that already exist

- **Rate limiting** (`middleware/rate-limit.js`, mounted in `server.js`): 1200/min
  for `/api/integration` keyed on the Basic username, 600/min each for
  `/api/mobile` and `/api/client`. **`/api/admin` is deliberately uncapped** —
  capping it would self-DoS a staff data-entry spree. It is bounded instead by
  `bodySizeLimit({maxBytes: 2MB})` on JSON only (multipart passes through so bulk
  xlsx upload keeps working); global `express.json()` is 10 MB, 25 MB for
  `/api/public/website-booking`. `failureBreaker` is the webhook variant: it charges
  only refusals and suppresses their logs, one summary line per window.
- **Maintenance gate** (`middleware/maintenance.js`): 503 + `Retry-After` on all
  API traffic during the QA schema refresh. `/api/health` is exempt on purpose —
  answering 503 there would make Docker's HEALTHCHECK restart the container
  mid-restore.
- **CORS** (`cors.js`): env allowlist (`CRM_URL` / `CLIENT_URL` / `MOBILE_APP_URL` /
  `SELF_URL`, comma-separated, trailing slash stripped) plus same-host auto-allow
  comparing `Origin` host to `Host`. `credentials: true`. A request with **no**
  `Origin` is allowed — curl and health probes, not a bypass.
- Email is **Microsoft Graph** (`MS_GRAPH_TENANT_ID`/`_CLIENT_ID`/`_CLIENT_SECRET`,
  `services/ms-graph-token.service.js`). No ZeptoMail here. `.gitignore` covers
  `.env` and every backup shape (`.env.bak*`, `.env.*.bak`, …).
- Crons (`server/scheduler.js`, `Asia/Kolkata`) are gated on `easyfix_properties`
  via `getProperty` plus a `CRON_DISABLED` env kill switch. **Read the polarity**:
  `!== 'false'` defaults ON, `=== 'true'` defaults OFF — a new job written with the
  wrong one either never runs or runs unrequested in prod.

## Deliberate trade-offs — do NOT file these as findings

Each is documented at the site; a reviewer who reports it wastes a cycle, and one
who does not know it exists misreads the surrounding code.

- **Integration passwords are stored PLAINTEXT** in `tbl_client_user.password` /
  `tbl_client_website.login_password`. The legacy Dropwizard `:8090` service still
  does a plaintext compare against the same shared column, so hashing breaks every
  partner and buys nothing against a dump. `middleware/basic-auth.js` carries the
  decommission runbook; the precondition is legacy retirement.
- **`?token=<jwt>` is accepted by `middleware/auth.js` on every route it guards**,
  not only the image endpoint its header describes — the scoping is a frontend
  convention, not a server check. The trade-off is reasoned (query tokens are
  CSRF-immune, unlike the cookie fallback deliberately not built) and this app's own
  logs redact it; proxy logs, `Referer` and history still see it. Not a new bug.
- **`pradeep@easyfix.in` has a static OTP (2468) in every environment including
  production**, and its OTP delivery is suppressed (`utils/otp.js`
  `STATIC_LOGIN_OTP_ACCOUNTS`). Blast radius is that one allowlisted low-privilege
  account. The genuine finding here is `QA_DETERMINISTIC_OTP=true` reaching prod —
  that makes *every* login guessable. Check the deployed env, not the code.
- **A deactivated technician keeps a working token** (`middleware/tech-auth.js`
  does not filter `efr_status`) so they can reach `/mobile/registration/status`.
  Work is blocked at the assignment layer instead.
- **`tbl_client_user` credentials cannot be disabled by a flag** — it has no
  `status` column, matching legacy. Flagged in `findCredential`, not fixed.

## Output format

| Severity | CWE | File:Line | Issue | Fix |
|----------|-----|-----------|-------|-----|

For any "every route is guarded" claim, enumerate the routes and report the ones
with **no** guard — a count of guard call sites is not evidence about the routes
that lack one. State what you could not verify and why.
