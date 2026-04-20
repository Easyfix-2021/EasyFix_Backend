# GitHub Actions Secrets — EasyFix_Backend

This document lists every secret the **backend** GitHub Actions workflow ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) needs, along with **what each value is** and **where to fetch it from**.

> **Reach this UI:** GitHub repo → **Settings** (top tab) → **Secrets and variables** → **Actions** → **New repository secret**.

---

## Required secrets

| Secret name | Purpose | Where to get the value |
|---|---|---|
| `QA_HOST` | Public IP (Elastic IP) of the **QA** EC2 backend instance — workflow SSHes here on push to `QA` branch. | AWS Console → **EC2** → **Elastic IPs** → row `easyfix-backend-qa` → copy the **Allocated IPv4 address** (e.g. `13.235.x.y`). |
| `QA_USER` | Linux user the deploy SSH session connects as. | `ubuntu` (matches the Ubuntu 22.04 AMI in the deployment guide). |
| `QA_SSH_KEY` | Private deploy SSH key whose **public** half is in `~/.ssh/authorized_keys` on the QA EC2. Lets GitHub Actions log in passwordless. | Generated locally per the [AWS Deployment Guide §4.1](AWS_DEPLOYMENT_GUIDE.md#41--generate-a-deploy-ssh-key) — the file `easyfix-backend-deploy` (NOT the `.pub` half). Open the file in a text editor and paste the **entire** contents including the `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----` lines. |
| `PROD_HOST` | Public IP (Elastic IP) of the **Production** EC2 backend instance. | AWS Console → **EC2** → **Elastic IPs** → row `easyfix-backend-prod` → **Allocated IPv4 address**. |
| `PROD_USER` | Linux user for SSH on Prod. | `ubuntu`. |
| `PROD_SSH_KEY` | Same deploy private key — the **public** half was added to BOTH instances' `authorized_keys`, so one key authenticates both. (Use a separate key per environment if you want stricter blast-radius.) | Same file as `QA_SSH_KEY`. |
| `MAIL_USERNAME` | Gmail address that **sends** the deploy-failure email. | Use `ithelpdesk@easyfix.in` (the same mailbox the backend's email service uses for transactional sends — already configured). Or any Gmail account you control. |
| `MAIL_PASSWORD` | App password for that Gmail account (NOT the regular login password). | [Google Account → Security → 2-Step Verification → App passwords](https://myaccount.google.com/apppasswords) → generate one named `github-actions-easyfix-backend` → copy the 16-character string (drop the spaces) → paste here. Requires 2-Step Verification enabled on the source account. |

---

## How each secret is consumed

```
┌─────────────────────────────────┐
│   push to QA / Production       │
└───────────────┬─────────────────┘
                ▼
   ┌─────────── deploy job ───────────┐
   │                                  │
   │  Resolve target host             │
   │  ├─ branch=QA   → QA_HOST/USER/KEY
   │  └─ branch=Prod → PROD_HOST/USER/KEY
   │  base_url = http://HOST:5100    │  ← EIP + raw app port (no DNS)
   │                                  │
   │  Set up SSH key                  │
   │  └─ writes <KEY> to ~/.ssh/deploy_key
   │                                  │
   │  Deploy via SSH                  │
   │  └─ ssh -i deploy_key  USER@HOST 'git pull && npm ci --omit=dev && npm run test:db && pm2 reload'
   │                                  │
   │  Smoke-test deployed API         │
   │  └─ curl http://HOST:5100/api/health
   │      curl http://HOST:5100/api/health/db
   │      curl http://HOST:5100/api/integration/_ping
   │                                  │
   │  On failure: Email step          │
   │  └─ MAIL_USERNAME + MAIL_PASSWORD → smtp.gmail.com:465 → harshit@channelplay.in
   └──────────────────────────────────┘
```

---

## Step-by-step: add the secrets in the UI

1. Open the repo on GitHub → **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret** (top right).
3. **Name** field: type the secret name from the table above.
4. **Secret** field: paste the value.
5. Click **Add secret**.
6. Repeat for each row. Once added they show as `••• Updated N seconds ago` — values are write-only after creation.

---

## Rotating a secret

GitHub UI: same page → click the secret name → **Update** → paste new value → **Update secret**. Next workflow run uses it.

When to rotate:
- **`*_SSH_KEY`**: if the private key file leaks, or annually as policy.
- **`MAIL_PASSWORD`**: if revoked / sending account changes.
- **`*_HOST`**: only if you reallocate the Elastic IP (rare).

---

## Optional: GitHub Environment for Production gating

For stricter prod control, scope `PROD_*` secrets to a [GitHub Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) named `production` and add **Required reviewers**. UI walkthrough:

1. Repo → **Settings** → **Environments** → **New environment** → name `production` → **Configure**.
2. ☑ Required reviewers → add yourself + a teammate.
3. Move `PROD_HOST`, `PROD_USER`, `PROD_SSH_KEY` from repo-level secrets into this environment.
4. In `deploy.yml`, add `environment: production` to the deploy job when the branch is `Production` — the run will pause and request approval before SSH.

The current workflow is intentionally un-gated (push → deploy). Add the environment when team grows or compliance asks for a review trail.

---

## Verifying it works

After adding all secrets:
1. GitHub UI → **Actions** → `Deploy to AWS EC2` → **Run workflow** → choose `qa` → **Run workflow**.
2. Watch the run: `build` job (~2 min), then `deploy` (~5 min).
3. **Failure modes & remedies:**
   - `Permission denied (publickey)` on the SSH step → `*_SSH_KEY` value has stray whitespace OR the public key isn't in `~/.ssh/authorized_keys` on the EC2. Re-paste carefully (preserve the trailing newline) and re-add the public key.
   - `npm run test:db` fails → DB host firewall doesn't allowlist the EC2's outbound IP. Ask the DBA team to add the EIP to the `tbl_user`-style allowlist for `111.93.206.91:3306`.
   - `Smoke-test` fails on `/api/health/db` → backend booted but the pool can't reach MySQL. SSH in: `pm2 logs easyfix-backend` for the connection error. Usually a wrong `DB_PASSWORD` or a pool-saturation race after a fresh boot — wait 30 s and retry.
   - `Smoke-test` fails on `/api/integration/_ping` → the legacy-shape response middleware regressed. Roll back via re-running the previous successful workflow.
   - `Notify by email on failure` errors with `535 Authentication failed` → `MAIL_PASSWORD` is wrong or 2-Step Verification isn't on for the Gmail account.

---

## What is NOT in this list

These are **not** GitHub secrets — they live elsewhere:

| Variable | Where it lives |
|---|---|
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT` | `~/EasyFix_Backend/.env` on each EC2. The deploy never touches the DB credentials — they're set once during bootstrap. To rotate, SSH in and edit the file, then `pm2 reload easyfix-backend --update-env`. |
| `JWT_SECRET`, `SUITE_URL` | `~/EasyFix_Backend/.env`. Different per environment. |
| `SMSCOUNTRY_*`, `GALLABOX_*`, `GMAIL_*`, `FCM_API_KEY` | `~/EasyFix_Backend/.env`. Use `TEST_EMAILS` / `TEST_MOBILE` overrides on the QA instance to redirect outbound notifications away from real customers. |
| `WEIGHT_*`, `MAX_CONCURRENT_JOBS` | `~/EasyFix_Backend/.env` for built-in defaults. Per-client overrides live in the `tbl_autoallocation_setting` + `tbl_client_setting` DB tables, edited via the **Manage Auto Allocations** CRM page. |
| TLS certificate + private key | Managed by **Let's Encrypt + Certbot** on the EC2 (auto-renewal cron). Never pulled through GitHub. |
| AWS API credentials | The deploy uses **SSH**, not the AWS SDK — no AWS creds needed in this repo's secrets. If you migrate to ECS Fargate / RDS later, you'll add `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (preferably an OIDC role ARN) here. |

---

## Secrets cross-repo cheat sheet

If you've already set up [Easyfix_CRM_UI/docs/GITHUB_SECRETS.md](../../Easyfix_CRM_UI/docs/GITHUB_SECRETS.md), these secrets are **shared with the same names across both repos**:

- `MAIL_USERNAME`, `MAIL_PASSWORD` — same Gmail account works for both
- `*_SSH_KEY` — keep separate values per repo (different deploy keys → different EC2s)
- `*_HOST` — different IPs (frontend EC2 vs backend EC2 are separate instances)

Each repo has its own `.github/workflows/deploy.yml` and its own secret store — secrets DON'T cross-pollinate. You add `MAIL_USERNAME` once in each repo's settings even though the value is identical.
