# Legacy Retirement Runbook — Phase 15

> **Purpose**: step-by-step cutover from legacy services to the unified `EasyFix_Backend`. Execute this **only after** Phases 1A–14 are live and 2+ weeks of parallel-run diff-testing have passed.

## Pre-cutover checklist

- [ ] All 14 phases marked DONE in `PHASE_PLAN.md`
- [ ] Shadow-traffic diff harness (capture production `/v1/*` requests, replay against `/api/integration/v1/*`, diff byte-for-byte) **green for 14 consecutive days**
- [ ] `webhook_logs` show new-backend deliveries matching legacy for the same jobs (ops spot-check)
- [ ] All CRM users trained on new CRM_UI
- [ ] All client SPOCs notified of Client_UI URL change (if any)
- [ ] Technician apps updated (FCM token flow tested)
- [ ] Database backups taken the morning of cutover
- [ ] Rollback plan documented (flip Nginx `location` blocks back, legacy services still warm for 2–4 weeks post-retirement)

## Cutover sequence (Nginx edits)

### Step 1 — Webhook dispatcher (Phase 2 → Phase 15.1)
```
# Before: internal Java services fire HTTP POST to Webhook_2023 :7070
# After:  internal new-backend webhook.service dispatches directly (no HTTP hop)
#
# Action: shut down Webhook_2023. No Nginx change needed — it was never
# publicly routed.
```
```bash
ssh ec2
sudo systemctl stop easyfix-webhook   # or `pm2 stop webhook_2023`
sudo systemctl disable easyfix-webhook
```

### Step 2 — External Integration API (Phase 3 → 15.2)
```nginx
# /etc/nginx/sites-enabled/easyfix.conf
# Before:
location /v1/ {
    proxy_pass http://localhost:8090/v1/;   # Dropwizard
}
# After:
location /v1/ {
    proxy_pass http://localhost:5100/api/integration/v1/;
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop easyfix-api  # Dropwizard :8090
```

### Step 3 — Client Dashboard API (Phase 4 → 15.3)
```nginx
# Before:
location /acd-dashboard-api/ {
    proxy_pass http://localhost:7060/acd-dashboard-api/;   # ACD_APIs
}
# After:
location /acd-dashboard-api/ {
    proxy_pass http://localhost:5100/api/client/;
}
# Angular_ClientDashboard: keep serving from same path (no backend change) OR
# replace with Client_UI bundle under /corporates if rebuilt.
```
```bash
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop acd-apis
```

### Step 4 — Technician Mobile API (Phase 5 → 15.4)
```nginx
# Before:
location /test-api/ {
    proxy_pass http://localhost:8060/test-api/;   # API_AngularClientDashboard
}
# After:
location /test-api/ {
    proxy_pass http://localhost:5100/api/mobile/;
}
# Existing installed APK / IPA clients continue hitting the same URL.
```
```bash
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop api-angular-client-dashboard
```

### Step 5 — CRM/Struts (Phase 15.5 — FINAL)
```nginx
# Before:
location /easyfix/ {
    proxy_pass http://localhost:8080/easyfix/;   # Tomcat/Struts
}
# After:
# Serve CRM_UI static bundle OR reverse-proxy to the new Next.js server:
location /crm/ {
    proxy_pass http://localhost:5180/;
}
# Redirect /easyfix/ → /crm/ for 90 days:
location /easyfix/ {
    return 301 /crm/;
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx
# Keep Tomcat warm for 4 weeks in case anything breaks:
sudo systemctl stop tomcat8
# After 4 weeks of green:
sudo apt-get remove --purge tomcat8 mysql-java-connector
```

## Post-cutover

- [ ] Monitor `webhook_logs.__delivery.httpStatus` distribution for 7 days — any spike in non-200 = rollback.
- [ ] Watch Decathlon / Powermax callback error rates (they email support if they see 4xx/5xx).
- [ ] Audit `tbl_user_login_logout_logs` — are users still logging in via legacy paths? If yes, fix redirects.
- [ ] Decommission legacy MySQL users (`db_usr_easyfix`, `oodles-team`) AFTER confirming only new backend queries the DB. Rotate `JWT_SECRET` (new one used across all services; nothing still signs tokens with `esyfixsecret`).
- [ ] Archive legacy repos: `git tag retired-2026-XX-XX` on each of EasyFix_CRM, ACD_APIs, API_AngularClientDashboard, Webhook_2023, EasyFix_API.

## Rollback triggers

| Symptom | Rollback action |
|---|---|
| Decathlon callbacks returning 4xx/5xx at >1% rate | Revert Step 2 Nginx block |
| CRM users report missing features | Revert Step 5 Nginx block |
| Tech app unable to accept/reject jobs | Revert Step 4 Nginx block |
| Mass webhook delivery failure | Ensure Webhook_2023 systemd unit is NOT stopped; revert fireWebhook in job.service to no-op until fixed |

## Retention

- Keep legacy service binaries + DB backup tarballs for **90 days** post-retirement.
- Keep the legacy source repos read-only forever (archived tags).
- `webhook_logs` table: retain 180 days minimum for dispute resolution.
