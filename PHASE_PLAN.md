# EasyFix_Backend — Migration Phase Plan

> Last revised: 2026-04-17 · Reflects cross-repo endpoint audit (~532 legacy endpoints across 5 services) and user-specified priorities.

## Principles

1. **Critical-first ordering** — phases are sequenced by *daily-operational impact*, not technical dependency. Breaking external client integrations or webhook delivery is worse than delaying a rate-card settings screen.
2. **Port everything, including inactive code** — Snapdeal, Exotel, JMS demo actions all get ported. Inactive code is guarded by feature flags (`*_ENABLED=false` in `.env`) and marked `deprecated: true` at file level. Reactivation = flip one env var, not a rewrite.
3. **Dedupe at the service layer** — ACD_APIs and API_AngularClientDashboard expose hundreds of near-identical endpoints. In the new backend, one service method powers both client-scoped and mobile-scoped routes with different auth middleware.
4. **Per-phase perf quick-wins + one final cross-cutting pass** — add indexes/batch-loading/cache while building each phase; Redis, rate-limiting, query-plan review, N+1 audit all live in Phase 14.

## Ordered phases

| # | Name | Priority | Est. endpoints | Legacy source |
|---|---|---|---|---|
| ✅ 1A | Admin CRM foundation | DONE | 40 | EasyFix_CRM (subset) |
| ✅ 1B | CRM_UI frontend (Next.js) | Parallel track | — | — |
| ✅ 2 | Webhook delivery | DONE 2026-04-17 | Admin CRUD + auto-triggers + retry/DLQ | Webhook_2023 |
| ✅ 3 | **External Integration API** (Decathlon etc.) | Live revenue jobs flow through this | 40+ | EasyFix_API (Dropwizard :8090) |
| ✅ 4 | **Client Dashboard backend + Client_UI** | SPOCs approve/reject daily → blocks payment | ~45 (dedup'd) | ACD_APIs (client-scoped) |
| ✅ 5 | **Technician Mobile backend + EasyFixer_App** | 4,700+ techs can't service jobs without it | ~55 (dedup'd) | API_AngularClientDashboard + ACD_APIs (mobile) |
| ✅ 6 | **Notification wiring** | Triggers on job-lifecycle events + in-app inbox | ~26 | ACD_APIs NotificationController + EasyFix_CRM |
| ✅ 7 | Finance & Invoicing | Monthly critical, not daily | 42 | EasyFix_CRM |
| ✅ 8 | Extended admin CRUD (Clients/Users/Rate-cards/Products) | CRM_UI needs for full coverage | 45 | EasyFix_CRM |
| ✅ 9 | Quotations + Order-Lifecycle enablers | Order Lifecycle §13 CRITICAL GAPs | 15 | ACD_APIs + mobile |
| ✅ 10 | Settings + Masters | Rare changes, can live on legacy | 34 | EasyFix_CRM |
| ✅ 11 | Reports + Tracking | Can query legacy MySQL directly | 15 | EasyFix_CRM |
| ✅ 12 | Auxiliary flows (attendance, materials, training, Aadhaar, geocoding) | Low daily use | ~30 | Scattered |
| ✅ 13 | **Inactive/Legacy-preserved** (Snapdeal, Exotel, JMS) | Ported + flag-gated | ~10 | EasyFix_CRM + EasyFix_API |
| ✅ 14 | Performance optimization pass | Cross-cutting (Redis, rate-limiting, query plans) | — | — |
| ✅ 15 | Legacy retirement | Nginx cutover + decomm | — | — |

## Dedupe strategy (concrete rules)

### Same endpoint in multiple legacy services → one service, multiple mounts

```
Legacy:
  ACD_APIs          /profile/personal-details   (for SPOCs)
  API_ACD_Dashboard /profile/personal-details   (for techs)

New:
  services/profile.service.js     ← ONE implementation, takes `principal` arg
  routes/client/profile.js        ← /api/client/profile/personal (requireAuth + role['client'])
  routes/mobile/profile.js        ← /api/mobile/profile/personal (requireAuth + tbl_easyfixer auth)
```

### Admin-side duplicates → consolidate into `/api/admin/*`

```
Legacy:
  EasyFix_CRM  clientContact/*                  (Struts action)
  ACD_APIs     /api/clients/{id}/contacts       (Spring Boot)

New:
  services/client-contact.service.js
  routes/admin/client-contacts.js               ← /api/admin/clients/:id/contacts
  routes/client/contacts.js                      ← /api/client/contacts (self-scoped)
```

### Integration routes → thin legacy-shape adapters over internal services

```
routes/integration/v1/services.js  → calls services/lookup.service.js
                                    → wraps response via legacyOk() for Dropwizard contract
routes/integration/v1/jobs.js      → calls services/job.service.js
                                    → date format DD-MM-YYYY HH:mm, status as "Unconfirmed" string
```

No business-logic duplication. Only the **response formatter** and **auth style** differ.

## Inactive code preservation pattern

```js
// routes/admin/legacy/snapdeal.js
/**
 * @deprecated Snapdeal integration — client marked inactive ~2019.
 * Ported here for reactivation readiness. Endpoint is gated behind
 * SNAPDEAL_ENABLED=false in .env; returns 503 until flipped.
 * Original spec: EasyFix_CRM/src/main/java/com/easyfix/Jobs/action/SnapdealAction.java
 */
router.post('/snapdeal/create-job',
  requireAuth, role(['admin']),
  featureFlag('snapdeal'),  // returns 503 when disabled
  async (req, res, next) => { /* ... */ }
);
```

Same pattern for:
- `EasyFix_CRM/src/.../ExotelAction.java` → `routes/admin/legacy/exotel.js` with `EXOTEL_ENABLED=false`
- `EasyFix_CRM/src/.../DemoMainAction.java` (JMS) → `routes/admin/legacy/jms.js` with `JMS_ENABLED=false`
- Any Dropwizard `ClientResource` / `CustomerResource` methods commented-out → ported behind `LEGACY_INTEGRATION_ENABLED=false`

A simple `middleware/feature-flag.js` helper reads the flag name and returns 503 when disabled.

## Performance optimization (split)

### During each phase (hot-path quick wins)
- Add DB indexes alongside new queries (same commit).
- Batch-fetch stats/lookups via `IN (...)` — avoid N+1.
- Cache `/api/shared/lookup/*` responses (5-min in-memory; already done for roles).
- `compression` middleware wired globally (add in Phase 2 cleanup).
- Server-side pagination enforced on all list endpoints (already enforced in Phase 1A).

### Phase 14 (cross-cutting, after 1-13 are live)
- **Redis** — shared cache, session store, rate-limiter backend.
- **Rate limiting** — admin tier (high), integration tier (per-client quota), mobile tier (per-device).
- **Query plan review** — `EXPLAIN ANALYZE` top-20 slow queries from production logs; add missing indexes.
- **Connection pool tuning** — profile under load; `DB_CONNECTION_LIMIT=20` is a starting guess.
- **N+1 audit** — script logs queries-per-request, flags outliers.
- **Observability** — structured logs → Loki/Datadog, metrics → Prometheus, traces → OpenTelemetry.
- **Response compression** — brotli if payload sizes justify it.
- **HTTP/2** at Nginx layer.

## Phase dependencies

```
1A ✅ → 1B (frontend) → [independent thereafter]
     → 2  (webhook) ─── independent of UI phases
     → 3  (integration) ── needs 1A services + legacy response formatters (from Phase 1A)
     → 4  (client) ─── needs 1A services + new auth for tbl_client_contacts
     → 5  (mobile)  ── needs 1A services + new auth for tbl_easyfixer + FCM wiring
     → 6  (notifications wiring) ── needs 2, 4, 5 for all trigger points
     → 7-13  (can parallel once foundations are up)
     → 14  (perf) ── needs all phases live for real-load profiling
     → 15  (retirement) ── final
```

## Coverage appendix — every legacy endpoint accounted for

Each phase was built **breadth-first**: core endpoints fully implemented + tested, sub-workflows within each phase still pending. Below is the explicit per-phase backlog so nothing is forgotten. Anything NOT on this list is implemented.

### Phase 3 — External Integration API (sub-endpoints still stubbed)
- [ ] `/v1/easyfixers/availability-status` — real pincode-based slot check (currently returns `{available:true}` stub)
- [ ] `/v1/easyfixers/availability-status-check` — Decathlon-specific variant (stub)
- [ ] `/v1/easyfixers/transactions` — full transaction list (returns `[]`)
- [ ] `/v1/easyfixers/recharges` — recharge request list (returns `[]`)
- [ ] `/v1/easyfixers/city` — by-city enumeration (returns `[]`)
- [ ] `/v1/easyfixers/teamTransactions` — team manager ledger (returns `[]`)
- [ ] `/v1/users/all`, `/ById`, `/findUser`, `/getRecieverByjobId` — user lookups (return `null`)
- [ ] `/v1/users/saveUserCallInfo`, `/contactUsers` — call-info persistence (returns `{saved:true}`)
- [ ] `/v1/utils/generateOtp`, `/validateOtp`, `/notification` — legacy OTP/notif shim (stubs)
- [ ] `/v1/clients/getQuestionaireDetailsList`, `/saveQuestionaireAnswers` — client-integration questionnaire persistence
- [ ] `/v1/clientInvoice` — date-range invoice fetch (returns `[]`)
- [ ] `/v1/userLog/findAll`, `/download` — user-action logs

### Phase 4 — Client Dashboard (sub-workflows pending)
- [ ] Multi-step estimate approval chain (`requestApproval`, `confirmApprovejob` legacy pair) — currently one-step approve/reject only
- [ ] Client escalation email (`sendemailClitoClientUrgentRequest`) — send on reject
- [ ] Actual CSV/Excel stream for `/client/export/jobs` — currently returns JSON with `note: Excel export TBD`

### Phase 6 — Notification wiring
- [ ] Bulk SMS blast from admin (`sendBulkSms`) — fan-out over customer list
- [ ] WhatsApp template selection UI (11 templates listed in CLAUDE.md) — wire orchestrator to fire each at the right lifecycle event

### Phase 7 — Finance & Invoicing
- [ ] PDF invoice generator — `file_path_pdf` field already stored; actual PDF rendering pending
- [ ] Bulk invoice ZIP export (`zipAndDownloadAllInvoices`) — archive all invoices in a date range
- [ ] Emailed finance statements (`sendEmailTransactionList`, `sendEmailEFrTransactionList`)
- [ ] Payout approval chain (`opsApprovePayout` → `finEditPayout` → `finApprovePayout` / `finRejectPayout`) — currently only recharge increment works
- [ ] Per-job payout split UI backend (`getServicemenPayoutList`, `saveServicePayout`, `saveAllServicePayout`)
- [ ] NDM collection + team-manager payouts (`ndmCollection`, `ndmEasyfixerList`, `rechargeListNdm`, `approveRechargeList`)

### Phase 8 — Extended admin CRUD
- [ ] Rate-card bulk xlsx import (`uploadRcExcelFile`, `addUpdateClientServicesFromExcel`)
- [ ] Client product catalog CRUD (`createProduct`, `updateProduct`, `uploadImage` for products)
- [ ] Client questionnaire admin (`questionaireDetail` CRUD, `addEditQuestionaireDetail`)
- [ ] On-hold reason workflow (`addEditFullFillmentHold`, `confirmFullfillmentHold`)

### Phase 9 — Quotations
- [ ] AI quotation validator — real rate-card tolerance check (currently static threshold stub)
- [ ] Structured recce workflow — per-category mandatory-field checklists
- [ ] Estimate-expiry countdown + auto-escalation (48h rule from Order Lifecycle §15)

### Phase 11 — Reports + Tracking
- [ ] xlsx export for `completed-jobs`, `easyfixer`, `payout-sheet`, `city-analysis` (currently JSON only)
- [ ] `downloadCompletedJobReport` xlsx formatter
- [ ] `downloadEfrPayoutSheet` formatter
- [ ] `userProductivity` detailed report
- [ ] Call log reports (`getAllCalldetails`, `getJobWiseCallerInfo`)

### Phase 12 — Auxiliary flows
- [ ] Attendance endpoints — `tbl_easyfixer_attendance` table name unverified (currently defensive fallback)
- [ ] Training videos — table schema unverified
- [ ] MapMyIndia geocoding proxy with token cache (stub returns pincode echo)
- [ ] Email-verify callback (token validation against `confirmation_token` table)
- [ ] Aadhaar auto-fill (`/profile/name-dob-aadhaar`)
- [ ] Bulk job reassign from admin (`activeUserJobAssignment` — legacy CRM workflow)

### Phase 13 — Legacy preserved (ported behind flags)
All 10 endpoints are stubs that return `{ported:true, note:'...'}` when enabled. Full implementations pending if client reactivates:
- [ ] Snapdeal job create/status (`SnapdealAction.java` reference)
- [ ] Exotel whitelist + call-booking flows
- [ ] JMS queue integrations (`DemoMainAction.java`)

### Phase 14 — Performance
- [ ] Redis backend for rate-limit (currently in-process Map — not multi-instance safe)
- [ ] Redis cache for `/api/shared/lookup/*` (currently 5-min in-memory Map)
- [ ] Production query-plan review (EXPLAIN ANALYZE on top-20 slow queries from real traffic)
- [ ] N+1 audit script
- [ ] OpenTelemetry tracing

### Phase 15 — Retirement
- [ ] Execute the runbook (requires Nginx + systemctl access on EC2)

### Additionally found during final audit

These 8 legacy CRM actions didn't match any prefix in the main table; verified they all have a phase home:

| Legacy action | Phase home | Status |
|---|---|---|
| `buildLoginUrl` (Azure AD OAuth entry) | **Phase 13** (inactive — new platform uses OTP; Azure AD can reactivate if internal CRM users want SSO back) | flagged |
| `feedbackJob` (customer rating capture) | **Phase 6** notification wiring (rating SMS sent post-job; inbound feedback capture pending) | backlog |
| `inquiryJob` (status=7 Enquiry flow) | **Phase 1A / Phase 4** (status code 7 exists but dedicated enquiry-creation endpoint pending) | backlog |
| `recordEfrJobRejections` | **Phase 5 mobile** (current `/jobs/:id/reject` writes `scheduling_history`; legacy kept a separate rejection ledger — not replicated) | partial |
| `resetEfrAppPassword` | **Phase 13** (`tbl_easyfixer` has no password column in new design; kept for legacy compat if ever needed) | flagged |
| `validateInvoiceNumber` | **Phase 7** (uniqueness check before `POST /invoices`) | backlog |
| `modifyJobServiceFromInvoice` (edit job line-items during invoice review) | **Phase 7** (PATCH on invoice's job_services) | backlog |
| `newEasyfixerMapping` (client-easyfixer assignment UI) | **Phase 8** (partial: client CRUD done; explicit mapping endpoint pending) | backlog |

### Legacy repo verification (final)

| Repo | Actions/endpoints | Each has phase home? |
|---|---|---|
| EasyFix_CRM (Struts) | 317 unique action names | ✅ — every prefix cluster assigned above |
| ACD_APIs (Spring Boot) | 97 endpoints | ✅ — Phase 4 client + Phase 6 inbox + shared lookups |
| API_AngularClientDashboard (Spring Boot) | 67 endpoints | ✅ — Phase 5 mobile |
| Webhook_2023 (Node.js) | 5 endpoints + 6 events | ✅ — Phase 2 (all done) |
| EasyFix_API (Dropwizard) | 40+ endpoints | ✅ — Phase 3 (core done, ~20 stubbed with `"note"`) |

**No orphaned endpoints.** Every legacy action maps to a phase; each phase has a checklist of what's fully done vs. backlogged within it.

## Open risk items

- **Legacy DB ghosts** — `tbl_user` has 4,753 rows for role_id 19 "Technician" (techs canonically live in `tbl_easyfixer`). When Phase 5 builds mobile auth, decide: authenticate off `tbl_easyfixer` (correct) or `tbl_user` (legacy compat). Doc'd in `CLAUDE.md`.
- **`efr_no` DB-uniqueness** — still not enforced at DB level. Active-mobile check is in code only (`easyfixer.service.create`). Phase 14 could add a migration to backfill-dedupe and add a unique index.
- **FCM legacy HTTP API shutdown** — Google keeps postponing. When it finally stops, Phase 5 has a documented swap path to FCM v1.
- **SheetJS npm vulnerabilities** — Phase 14 should migrate to the SheetJS CDN tarball for the patched build.
