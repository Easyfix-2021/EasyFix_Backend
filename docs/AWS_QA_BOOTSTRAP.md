# AWS QA EC2 — Empty-Box Bootstrap (build-on-EC2 via Docker + SSM)

**Target host:** `10.30.2.30` — AWS EC2 (Easyfix-qa-appsrv-2)
**Hosts:** EasyFix_Backend (port 5100) + Easyfix_CRM_UI (port 5180), both as Docker containers
**Connectivity from CI:** AWS Systems Manager (SSM) Run-Command
**Image build:** on the EC2 itself (no ECR for now — see "Migrate to ECR (later)" at the end)

---

## Architecture

```
GitHub-hosted runner (public)             AWS                          EC2 (10.30.2.30)
─────────────────────────────             ───                          ────────────────
git push origin QA
       │
       ▼
typecheck / node --check (fail-fast)
       │
       ▼
aws ssm send-command ─────────────────► SSM API ────► SSM Agent (long-poll)
                                                          │
                                                          ▼
                                                  ┌─ git fetch + reset ───────────┐
                                                  │  in /opt/easyfix/repos/<repo> │
                                                  ├─ docker compose build <svc> ──┤
                                                  ├─ docker compose up -d <svc> ──┤
                                                  └─ wait for HEALTHY status ─────┘
                                                          │
                                                          ▼
                                                  smoke test via second SSM call
```

**Key properties:**
- No SSH, no public IP, no inbound port 22.
- Source code is cloned ON the EC2 (under the deploy user's home), used as
  the Docker build context. No ECR yet.
- The two services share `/opt/easyfix/docker-compose.yml`. Each repo's
  workflow rebuilds + restarts ONLY its own service.
- App secrets stay on the EC2 in `/opt/easyfix/backend.env`. Never in
  GitHub, never in the image.

---

## Where every env var lives — read this first

This is the model for all configuration. Get it right once, never think
about it again.

### Layer 1: GitHub repository secrets

Used **only by the CI runner during the workflow**. Never reach the EC2.

| Secret | Used by | Why it's in GitHub |
|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | `aws-actions/configure-aws-credentials` | Auth for `aws ssm send-command` — the CI runner needs this to talk to the SSM API |
| `QA_INSTANCE_ID` / `PROD_INSTANCE_ID` | `aws ssm send-command --instance-ids` | Which EC2 to target |
| `MAIL_USERNAME` / `MAIL_PASSWORD` | `dawidd6/action-send-mail` | Failure-alert SMTP credentials |

**That's it.** No DB password, no JWT secret, no `NEXT_PUBLIC_API_URL`,
no third-party API tokens. Anything an attacker breaching the GitHub
repo could steal goes one layer down.

### Layer 2: EC2 host filesystem at `/opt/easyfix/`

Used by Docker Compose and the running containers. Never in any image,
never in any git repo, never in GitHub Secrets.

```
/opt/easyfix/
├── docker-compose.yml     ← copied verbatim from EasyFix_Backend/deploy/docker-compose.yml
├── .env                   ← compose-time vars (auto-loaded by `docker compose`)
├── backend.env            ← runtime secrets, mounted into the backend container
└── repos/
    ├── EasyFix_Backend/   ← git clone, branch QA, Dockerfile is the build context
    └── Easyfix_CRM_UI/    ← git clone, branch QA, Dockerfile is the build context
```

**`/opt/easyfix/.env`** — read by `docker compose` for variable
interpolation in the compose file. The CRM-UI Dockerfile receives
`NEXT_PUBLIC_API_URL` from this file as a `--build-arg`:

```bash
# /opt/easyfix/.env  — chmod 644 (no secrets here, just env-specific URLs)
NEXT_PUBLIC_API_URL=http://10.30.2.30:5100/api
```

**`/opt/easyfix/backend.env`** — referenced by the backend service via
`env_file:` in `docker-compose.yml`. Mounted into the container at
runtime — `dotenv` inside the Node app reads them via `process.env`.

```bash
# /opt/easyfix/backend.env — chmod 600 (REAL secrets)
NODE_ENV=production
PORT=5100

# Database — shared QA easyfix_core
DB_HOST=111.93.206.91
DB_PORT=3306
DB_USER=easyfix_qa
DB_PASSWORD=...
DB_NAME=easyfix_core

# JWT — generate fresh, do NOT reuse "esyfixsecret"
JWT_SECRET=<openssl rand -hex 32>
JWT_EXPIRY=30d

SUITE_URL=https://suite.1office.in

# Microsoft Graph (email)
MS_GRAPH_TENANT_ID=...
MS_GRAPH_CLIENT_ID=...
MS_GRAPH_CLIENT_SECRET=...
MS_GRAPH_SENDER_EMAIL=ithelpdesk@easyfix.in

# Provider feature flags (KEEP ON for QA until deliberate cutover)
NOTIFICATIONS_DISABLE=true
WEBHOOKS_DISABLE=true
TEST_EMAILS=harshit@channelplay.in
```

To **rotate a DB password**: SSH/Session-Manager into the EC2, edit
`backend.env`, run `docker compose up -d --force-recreate backend`.
30 sec, no GitHub touched, no redeploy needed.

To **change `NEXT_PUBLIC_API_URL`** (e.g. when DNS changes from IP to
hostname): edit `/opt/easyfix/.env`, run `docker compose build crm-ui`
+ `up -d crm-ui`. ~3 min for the rebuild.

### Layer 3: Inside the container

Read by the running app code. Never settable from outside the container
once it's running.

- **Backend**: `process.env.DB_HOST`, `process.env.JWT_SECRET`, etc. —
  populated by Compose from `backend.env`.
- **CRM-UI**: `process.env.NEXT_PUBLIC_API_URL` is BAKED into the static
  JS chunks at build time. The container itself doesn't see it as a
  runtime env — it's already inlined into `.next/static/chunks/*.js`.

---

## Prerequisites (one-time, AWS Console)

### 1. EC2 instance settings

| Setting | Value | Why |
|---|---|---|
| AMI | Ubuntu 22.04 LTS or Amazon Linux 2023 | Both ship `ssm-agent` (or available via snap on Ubuntu) |
| Instance type | `t3.medium` (2 vCPU, 4 GiB) | Building Next.js images peaks at ~1.5 GB |
| Disk | 30 GiB gp3 | Docker layer cache + build cache + git history |
| **IAM instance profile** | **`AmazonSSMManagedInstanceCore`** | Lets SSM agent register with AWS |
| Security group, inbound | 5100/tcp + 5180/tcp from internal CIDR | VPN clients reach the apps |
| Public IP / EIP | Not required | All CI traffic via SSM API |

### 2. IAM user for GitHub Actions

Create `github-actions-deploy` with this least-privilege policy.
Replace `<region>`, `<acct>`, and the instance IDs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RunShellScriptOnDeployTargets",
      "Effect": "Allow",
      "Action": ["ssm:SendCommand"],
      "Resource": [
        "arn:aws:ec2:<region>:<acct>:instance/i-<qa-id>",
        "arn:aws:ec2:<region>:<acct>:instance/i-<prod-id>",
        "arn:aws:ssm:<region>:*:document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "ReadCommandResults",
      "Effect": "Allow",
      "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
      "Resource": "*"
    }
  ]
}
```

Generate an access-key pair (IAM → Users → Security credentials →
"Application running outside AWS"). Save the secret — only displays once.

### 3. GitHub repository secrets (in BOTH repos)

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | from §2 |
| `AWS_SECRET_ACCESS_KEY` | from §2 |
| `AWS_REGION` | `ap-south-1` |
| `QA_INSTANCE_ID` | `i-032aa9d2942305364` |
| `PROD_INSTANCE_ID` | (when prod is provisioned) |
| `MAIL_USERNAME` / `MAIL_PASSWORD` | Gmail SMTP for failure alerts |

Notably **NOT** in GitHub Secrets:
- DB password, JWT secret, MS Graph creds → `/opt/easyfix/backend.env`
- `NEXT_PUBLIC_API_URL` → `/opt/easyfix/.env`

---

## One-time server bootstrap

Connect via **AWS Console → EC2 → Instances → Connect → Session Manager
→ Connect**. Browser-based root shell, no SSH key needed.

### A. Confirm SSM agent

```bash
sudo -i
systemctl status snap.amazon-ssm-agent.amazon-ssm-agent.service | head -5
# (or: systemctl status amazon-ssm-agent | head -5 if installed via .deb)
```

If missing: `snap install amazon-ssm-agent --classic`.

Verify SSM has registered the box: AWS Console → Systems Manager →
Fleet Manager — your instance shows green "Online".

### B. Install Docker + Compose plugin + git

Ubuntu 22.04:

```bash
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker
docker --version
docker compose version
git --version
```

Amazon Linux 2023:

```bash
dnf install -y docker git
systemctl enable --now docker
mkdir -p /usr/libexec/docker/cli-plugins
curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
  -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose
docker compose version
```

### C. Create the deploy user (no manual repo clone needed)

```bash
# Deploy user — NOT in sudoers, minimal privilege. The workflow itself
# clones the repos on first push (self-healing — see step F).
useradd -m -s /bin/bash easyfix-deploy

# Pre-create the directory the workflow will clone INTO.
mkdir -p /opt/easyfix/repos
chown -R easyfix-deploy:easyfix-deploy /opt/easyfix/repos
```

If the repos are **private**, set up a fine-grained PAT once so future
deploys can clone (and any subsequent `git fetch` works automatically).
The token never appears in GitHub Actions logs — it lives only on the EC2.

```bash
# Fine-grained PAT with read access to the org's repos. Generate at:
# GitHub → Settings → Developer settings → Personal access tokens (fine-grained)
# Permissions: Repository → Contents (Read-only) on the two repos.
sudo -iu easyfix-deploy bash -c '
  git config --global credential.helper store
  echo "https://<github-user>:<github-pat>@github.com" > ~/.git-credentials
  chmod 600 ~/.git-credentials
'
```

If repos are public, skip the PAT step entirely.

### D. Bootstrap env files via the interactive script

The repo ships an interactive script that prompts for one env var at a
time, figures out which file it belongs in (`.env` for build-args,
`backend.env` for runtime secrets), and auto-restarts the affected
Docker container after every change.

**First-time setup** — until the GH Actions workflow has cloned the
repo onto the EC2, fetch the script directly. Then run it once per
expected env var (see `deploy/bootstrap-env.example` for the full list):

```bash
# Fetch the script. Public repos:
curl -fsSL \
  https://raw.githubusercontent.com/Easyfix2021/EasyFix_Backend/QA/deploy/bootstrap-env.sh \
  -o /tmp/bootstrap-env.sh

# (Private repos: prepend  -H "Authorization: Bearer <github-pat>"  to the curl.)

chmod +x /tmp/bootstrap-env.sh

# Reference list of expected vars — fetch + read it for the full checklist:
curl -fsSL \
  https://raw.githubusercontent.com/Easyfix2021/EasyFix_Backend/QA/deploy/bootstrap-env.example \
  | less

# Run the interactive script ONCE PER VAR (prompts for key, file, value,
# confirmation, then auto-restarts whichever container needs the change).
sudo bash /tmp/bootstrap-env.sh

# After the first GH Actions deploy clones the repo, run from the local
# copy on every subsequent edit:
sudo bash /opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh
```

**Interactive flow example** (rotating the DB password):

```
$ sudo bash /opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh

EasyFix env-var manager

  ● compose / build-args (.env)         /opt/easyfix/.env  (1 keys)
  ● backend runtime secrets (backend.env)  /opt/easyfix/backend.env  (12 keys)

Env var KEY: DB_PASSWORD

'DB_PASSWORD' currently exists in:
  • /opt/easyfix/backend.env       value: *** (24 chars, masked)

What do you want to do?
  1) Update its value in backend.env
  2) Also add to .env
  3) Cancel
Choice [1]: 1

New value for DB_PASSWORD (input hidden):
Confirm value:

About to update:
  Key:   DB_PASSWORD
  File:  /opt/easyfix/backend.env
  Value: *** (28 chars, masked)

Proceed? [y/N] y
✓ Wrote DB_PASSWORD to /opt/easyfix/backend.env

Refresh affected docker container(s) now? [y/N] y
backend.env changed → recreating backend container
[+] Running 1/1
 ✔ Container easyfix-backend  Started
✓ Done
```

**What the script handles automatically:**

| Change | Auto-action |
|---|---|
| Edit any var in `backend.env` | `docker compose up -d --force-recreate backend` |
| Edit `NEXT_PUBLIC_*` in `.env` | `docker compose build crm-ui && up -d crm-ui` (build-time bake) |
| Edit other var in `.env` | Prompts which service(s) to refresh |
| Add a brand-new var | Asks which file, then proceeds as above |

**Permissions** are enforced automatically — `backend.env` stays at 600,
`.env` at 644, both owned by root. Values for `backend.env` are entered
masked (no echo to terminal); displayed values are also masked.

For the **first-time bulk setup**, just run the script once per key from
the reference list. Takes ~5 minutes for the ~12 backend.env keys + 1
.env key.

### E. First deploy — kick it from GitHub

The workflow handles everything else: clones the repos under
`/opt/easyfix/repos/` (using the PAT from §C if private), drops the
compose file into `/opt/easyfix/` if missing, builds the Docker image,
and starts the container.

On your laptop:

```bash
git checkout -b QA
git push -u origin QA
```

Watch **GitHub → Actions → Deploy Backend (build-on-EC2 via SSM)**.
The first push from each repo runs the typecheck on the GH runner, then
SSM-runs the rebuild on the EC2 (~30 sec warm because the bootstrap
already populated Docker's layer cache). On any failure, an email lands
at `harshit@channelplay.in`.

---

## Day-to-day operations

| Task | How |
|---|---|
| Deploy a change | `git push origin QA` |
| Manually redeploy | GitHub → Actions → Run workflow → pick QA |
| Tail backend logs | `docker logs -f easyfix-backend` (Session Manager into EC2 first) |
| Tail CRM-UI logs | `docker logs -f easyfix-crm-ui` |
| Rotate / update any env var (DB password, JWT, NEXT_PUBLIC_API_URL, anything) | `sudo bash /opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh` — prompts for key, takes new value (masked for secrets), auto-restarts affected container |
| Add a brand-new env var | Same script — when the key isn't found, asks which file (`.env` or `backend.env`) it should go into |
| Inspect what's currently set | `sudo bash /opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh` — top of output shows file paths + key counts. For a key-by-key list: `sudo grep -h '^[A-Z_].*=' /opt/easyfix/.env /opt/easyfix/backend.env \| cut -d= -f1` (keys only — won't print secrets) |
| Roll back to a specific commit | `git -C /opt/easyfix/repos/EasyFix_Backend reset --hard <sha>` then `cd /opt/easyfix && docker compose up -d --build backend` |
| Recover from a broken image | `docker compose down backend && docker compose up -d backend` (force a fresh build) |
| Wipe stale build layers | `docker builder prune -af` (the workflow does this automatically with `--keep-storage 2GB`) |
| See SSM history | AWS Console → Systems Manager → Run Command → Command history |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Workflow fails at "Configure AWS credentials" | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` missing | Re-create or paste the secrets correctly |
| SSM command fails with `InvalidInstanceId` | EC2 instance profile missing `AmazonSSMManagedInstanceCore`, or agent not running | Attach the policy + restart `snap.amazon-ssm-agent.amazon-ssm-agent.service` |
| `docker compose build` fails on the EC2 with permission denied | `docker.sock` access — `sudo` is needed (the workflow runs as root via SSM, so this is rare; only an issue if you try compose commands as `easyfix-deploy`) | The workflow runs as root deliberately. Manual commands need `sudo` |
| CRM-UI builds but every API call goes to localhost | `NEXT_PUBLIC_API_URL` missing / wrong in `/opt/easyfix/.env` | Both the workflow AND the Dockerfile guard against empty values now. If it still slipped through, re-check the file and rebuild |
| Smoke test "Connection refused" on 5100 | Container crashed on startup | `docker logs easyfix-backend` — usually a missing env var in `backend.env` |
| Disk filling up with old build layers | Builder cache | Workflow runs `docker builder prune --keep-storage 2GB` automatically. Manual: `docker builder prune -af` |
| `git fetch` fails with "Authentication failed" | Private repo, no PAT configured | See §C — set up `~/.git-credentials` for `easyfix-deploy` |

---

## Migrate to ECR (later)

Once DevOps has provisioned ECR repositories and is ready to ship to a
proper registry, the migration is small:

1. **AWS side**: create `easyfix/backend` and `easyfix/crm-ui` ECR repos.
   Attach `AmazonEC2ContainerRegistryReadOnly` to the EC2 instance profile.
   Add `ecr:*` permissions to the deploy IAM user (see commit history of
   this doc — `ecr` block lived in §2 before the build-on-EC2 pivot).

2. **Workflows**: re-add the `Build & push to ECR` job. Switch the SSM
   command from `docker compose build` → `docker compose pull`.

3. **Compose file**: swap each `build:` block for `image: ${BACKEND_IMAGE}`
   and `image: ${CRM_UI_IMAGE}`. Track the image tags via `BACKEND_IMAGE` /
   `CRM_UI_IMAGE` entries in `/opt/easyfix/.env` that the workflow updates
   on each deploy.

4. **EC2**: install `amazon-ecr-credential-helper` so `docker pull` from
   ECR works without explicit login.

The Dockerfiles themselves don't change — they build the same way
locally, on the EC2, or in CI. The migration takes ~30 minutes total.

---

## Why this architecture (current vs ECR target)

| Concern | Current (build-on-EC2) | After ECR migration |
|---|---|---|
| Source code on EC2 | Yes — needed as Docker build context | No — pulled image is enough |
| Image registry cost | Zero | Small (ECR storage + transfer) |
| CI build time | Lower (no push step) | Lower still (cache reuse across deploys) |
| Audit trail | Git log on the EC2 | Git log + ECR image manifest history |
| Multi-host scaling | Hard (each host re-builds) | Trivial (each host pulls the same image) |
| Rollback | `git reset --hard <sha>` + rebuild | Update tag in `.env` + `compose pull` |

For one EC2 with two services and a small team, build-on-EC2 is
operationally simpler. ECR pays off when there are 2+ EC2s or a need
for immutable, signed image artefacts.
