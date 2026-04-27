# QA In-house Deployment — Setup Runbook

Target host: **192.168.1.211** (private LAN, VPN-only access)
SSH port:    **3900**
App port:    **5100** (Express)
Branch:      **QA**

This runbook is the one-time setup for deploying `EasyFix_Backend` to the
in-house QA server using a **self-hosted GitHub Actions runner**. After this
is in place, every push to the `QA` branch auto-deploys.

---

## Why a self-hosted runner (and not a github-hosted one)

GitHub-hosted `ubuntu-latest` runners live on the public internet. They
**cannot** reach `192.168.1.211` because that's an RFC1918 private address
behind your VPN. Three ways to bridge that:

| Option | Verdict |
|---|---|
| Self-hosted runner on the LAN | ✅ Recommended — no VPN credentials in CI, no public ingress, free |
| Tailscale tunnel from hosted runner | OK — adds ~10 s tunnel-up per job, needs Tailscale account |
| Public bastion + reverse SSH | Works but extra infra to maintain |

The runner uses **outbound HTTPS only** to poll GitHub for jobs — no inbound
firewall hole, no exposed port. It's the standard way to deploy to private
networks.

---

## Safety-first (read before running anything)

The QA box already hosts other services (legacy Tomcat CRM, Dropwizard API,
possibly nginx, MySQL, PM2 under another user). Every command below is
written to add **alongside** what's there, never to replace it. Ground rules:

1. **Always run the preflight audit first.** It only READS the box:

   ```bash
   curl -fsSL -o /tmp/qa-preflight.sh \
     https://raw.githubusercontent.com/<org>/EasyFix_Backend/QA/scripts/qa-preflight.sh
   sudo bash /tmp/qa-preflight.sh | tee /tmp/preflight.log
   ```

   If it flags ✗ on a port we want (5100) or ✗ on GitHub connectivity, stop
   and resolve with the sysadmin before proceeding. Port 5100 is configurable
   via `PORT=` in `.env`; see "Port conflict" below.

2. **Never run `yum -y update`** on this box — it touches every other
   team's package. Install only what we need with `yum -y install <pkg>`.

3. **Never edit existing nginx vhosts.** If we front the API with nginx,
   we add one new file under `/etc/nginx/conf.d/easyfix-qa.conf`. We never
   touch `nginx.conf`, `default.conf`, or anyone else's `*.conf`.

4. **PM2 is per-user.** Our `pm2` runs under `easyfix-deploy`. If another
   team already runs PM2 as `root` or another user, both coexist — each
   has its own `~/.pm2` daemon.

5. **All destructive commands come with a rollback line** in the Rollback
   section at the end of this doc. If anything goes wrong, run those in
   reverse order.

6. **Port conflict:** if 5100 is taken, change `PORT=5180` (or any free
   port flagged OK by preflight) in `/home/easyfix-deploy/EasyFix_Backend/.env`,
   and update every subsequent curl/nginx proxy to that port. The workflow
   uses `PORT` from `.env` — no code change needed.

---

## One-time setup

### 1. Provision the QA server

Connect via VPN, then SSH on port 3900:

```bash
ssh -p 3900 <your-user>@192.168.1.211
```

Detect the OS family — commands differ between Debian/Ubuntu and RHEL:

```bash
cat /etc/os-release    # look at ID= and VERSION_ID=
```

#### Path A — Debian / Ubuntu

```bash
sudo apt update
sudo apt install -y curl git build-essential nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

#### Path B — RHEL family (CentOS 7, the `easyfix-websrv-uat` server)

**Why CentOS 7 gets its own block:** it's EOL (2024-06-30), default mirrors
404, and its glibc 2.17 can't run Node 20+. We use vault mirrors, install
only what's missing, and use `nvm` inside `easyfix-deploy` to get Node —
nothing system-wide.

##### 1.B.1 — Fix the EOL yum mirrors (idempotent, reversible)

```bash
# Only rewrites if still pointing at mirror.centos.org. Creates .bak
# backups so the change is fully reversible.
if grep -q 'mirror.centos.org' /etc/yum.repos.d/CentOS-*.repo 2>/dev/null; then
  sudo sed -i.bak \
    -e 's|^mirrorlist=|#mirrorlist=|g' \
    -e 's|^#\?baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' \
    /etc/yum.repos.d/CentOS-*.repo
  sudo yum clean all && sudo yum makecache
else
  echo "Mirrors already point away from mirror.centos.org — nothing to do"
fi
# Rollback (see Rollback section): restore each .bak file
```

##### 1.B.2 — Install only the packages we need (do NOT `yum update`)

```bash
# Base build tools — skip anything already present.
for pkg in curl git tar gcc gcc-c++ make libicu; do
  rpm -q "$pkg" &>/dev/null || sudo yum -y install "$pkg"
done

# libicu is needed specifically by the GitHub Actions self-hosted runner.
```

##### 1.B.3 — Nginx (OPTIONAL, and only additive)

Skip this entire sub-step if:
- Another team's nginx is already running (`systemctl is-active nginx` → active), **or**
- You don't plan to front the API with nginx (the workflow uses `127.0.0.1:5100` regardless).

If nginx is already installed, we **do not** touch it — we only drop a new
vhost file later.

```bash
if ! rpm -q nginx &>/dev/null; then
  sudo yum -y install epel-release
  sudo yum -y install nginx
  # Do NOT `systemctl enable --now nginx` if another service already owns
  # port 80 — check preflight output first.
  sudo systemctl enable --now nginx
fi
```

##### 1.B.4 — Firewall (minimal, additive)

```bash
# Only open 5100 if (a) firewalld is active AND (b) you want the API
# reachable from OTHER LAN hosts (e.g. the CRM_UI dev server).
# If nginx will proxy 80 → 5100, skip 5100 and rely on 80/443.
if systemctl is-active --quiet firewalld; then
  # Check first so we don't touch already-open ports
  firewall-cmd --zone=public --list-ports | grep -qw 5100/tcp || \
    sudo firewall-cmd --permanent --add-port=5100/tcp
  sudo firewall-cmd --reload
fi
```

##### 1.B.5 — SELinux (only if nginx will proxy to Node)

```bash
# Skip entirely if you're NOT fronting with nginx. If Enforcing and nginx
# can't reach Node on 5100 (proxy_pass returns 502), enable this boolean.
# Already-set → no-op.
if [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
  current=$(getsebool httpd_can_network_connect 2>/dev/null | awk '{print $NF}')
  if [[ "$current" != "on" ]]; then
    sudo setsebool -P httpd_can_network_connect 1
  fi
fi
```

##### 1.B.6 — Node via `nvm` (per-user, does NOT touch any system node)

CentOS 7's glibc 2.17 means Node 20 official binaries won't run. The last
Node 18 release that works on glibc 2.17 is **18.18.2**. We install it
under `easyfix-deploy`'s home dir so it can't collide with any other
team's node.

```bash
# Create the deploy user FIRST (skip if preflight already reported it exists)
id easyfix-deploy &>/dev/null || sudo useradd -m -s /bin/bash easyfix-deploy

sudo -u easyfix-deploy -i
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc

nvm install 18.18.2
nvm alias default 18.18.2
node --version            # expect v18.18.2

npm install -g pm2        # PM2 inside this user's nvm, not system-wide
pm2 --version
exit                      # back to root/sudo user
```

Sanity-check (still works on either path):

```bash
sudo -iu easyfix-deploy node --version   # → v18.18.2
sudo -iu easyfix-deploy pm2 --version
git --version
```

### 2. Create the deploy user

On CentOS 7 (Path B) this was already done inside step 1.B.6.

On Debian/Ubuntu (Path A):

```bash
id easyfix-deploy &>/dev/null || sudo useradd -m -s /bin/bash easyfix-deploy
```

Do **NOT** add this user to `sudoers` / `wheel` — it only needs to own its own
files and its PM2 daemon. Broad sudo rights on a shared host are a footgun.

### 3. Clone the repo + first install

```bash
sudo -u easyfix-deploy -i
git clone https://github.com/<org>/EasyFix_Backend.git ~/EasyFix_Backend
cd ~/EasyFix_Backend
git checkout QA           # the branch the workflow watches
npm ci --omit=dev

# Secrets — never committed; manage by hand on the server.
cp .env.example .env
nano .env                         # fill: DB_*, JWT_SECRET, MS_GRAPH_*,
                                  #       SUITE_URL, NOTIFICATIONS_DISABLE,
                                  #       TEST_EMAILS, etc.

# Verify DB connectivity before letting PM2 own the process
npm run test:db
```

### 4. Start under PM2 + enable on boot

```bash
# As easyfix-deploy
cd ~/EasyFix_Backend
pm2 start ecosystem.config.js
pm2 save

# Tell systemd to start PM2 (and therefore the app) on boot.
# CentOS 7 / nvm path: PM2 lives under the user's nvm, not /usr/bin — we
# have to give systemd the right PATH and point `pm2` at the nvm binary.
# Debian/Ubuntu with system-wide node: the simpler `/usr/bin` form works.
exit                              # back to your sudo-capable user

# --- CentOS 7 / nvm (our case) ---
NVM_BIN=$(sudo -iu easyfix-deploy bash -lc 'echo $NVM_DIR/versions/node/$(nvm current)/bin')
echo "nvm bin = $NVM_BIN"
sudo env PATH=$PATH:$NVM_BIN "$NVM_BIN/pm2" startup systemd \
     -u easyfix-deploy --hp /home/easyfix-deploy
# That prints a `sudo systemctl enable ...` line — copy-paste it as root.

# --- Debian/Ubuntu with system-wide node ---
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u easyfix-deploy --hp /home/easyfix-deploy

# Persist the current PM2 process list for that user
sudo -iu easyfix-deploy pm2 save
```

Sanity check:

```bash
curl -s http://127.0.0.1:5100/api/health         | jq
curl -s http://127.0.0.1:5100/api/health/db      | jq
```

Both should return `{ "success": true, ... }`.

### 5. Install the GitHub Actions self-hosted runner

In the GitHub repo:
**Settings → Actions → Runners → New self-hosted runner → Linux x64**.

GitHub generates a one-time registration token. On the QA server:

```bash
# Prereq (CentOS 7): the runner's `config.sh` imports libicu. If preflight
# reported it missing, install (idempotent — no-op if already present):
rpm -q libicu &>/dev/null || sudo yum -y install libicu

sudo -u easyfix-deploy -i
mkdir -p ~/actions-runner && cd ~/actions-runner

# Use the latest version + URL GitHub shows you — these are illustrative
[[ -f actions-runner-linux-x64.tar.gz ]] || curl -o actions-runner-linux-x64.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-x64-2.319.1.tar.gz
[[ -f ./config.sh ]] || tar xzf actions-runner-linux-x64.tar.gz

# Labels MUST include `qa-inhouse` — the workflow targets this label
# (not the QA branch name — labels are runner identifiers).
./config.sh \
  --url https://github.com/<org>/EasyFix_Backend \
  --token <REGISTRATION_TOKEN_FROM_GITHUB_UI> \
  --labels qa-inhouse,linux,x64 \
  --name easyfix-qa-inhouse \
  --unattended
```

Run it as a systemd service so it survives reboots:

```bash
# Back as a sudo-capable user
exit
cd /home/easyfix-deploy/actions-runner
sudo ./svc.sh install easyfix-deploy
sudo ./svc.sh start
sudo ./svc.sh status        # → active (running)
```

Confirm in GitHub: **Settings → Actions → Runners** — the runner appears as
`easyfix-qa-inhouse  Idle`.

### 6. Configure repo secrets

Only two secrets are needed (no SSH keys or hostnames — the runner deploys to
itself):

| Secret | Purpose |
|---|---|
| `MAIL_USERNAME` | Gmail account that sends deploy-failed emails |
| `MAIL_PASSWORD` | App password for that Gmail account |

Same secrets the existing AWS `deploy.yml` uses — reuse them.

---

## Day-to-day usage

```bash
# 1. Push to the QA branch
git push origin QA

# 2. Watch the workflow run in GitHub Actions
#    Stage 1 (lint) runs on ubuntu-latest. ~30s.
#    Stage 2 (deploy) runs on the self-hosted runner. ~60-90s.

# 3. Workflow ends with three smoke tests against http://127.0.0.1:5100.
#    If any of /api/health, /api/health/db, /api/integration/_ping returns
#    non-2xx, the job fails and harshit@channelplay.in gets an email.
```

Manual deploy (if you want to redeploy without a commit):

GitHub → **Actions → Deploy to QA In-house → Run workflow**.

---

## Roll-back

The deploy is `git reset --hard origin/QA + pm2 reload`. To roll
back, push a revert commit to `QA` (the workflow handles the rest)
or, in an emergency:

```bash
ssh -p 3900 easyfix-deploy@192.168.1.211
cd ~/EasyFix_Backend
git reset --hard <previous-good-commit-sha>
npm ci --omit=dev
pm2 reload easyfix-backend --update-env
```

---

## Optional: Nginx in front of port 5100

If you want HTTPS or a friendly LAN hostname (`https://qa-api.easyfix.local`),
drop a server block:

```nginx
# /etc/nginx/sites-available/easyfix-qa
server {
    listen 443 ssl http2;
    server_name qa-api.easyfix.local;

    ssl_certificate     /etc/ssl/certs/easyfix-qa.crt;
    ssl_certificate_key /etc/ssl/private/easyfix-qa.key;

    client_max_body_size 25m;          # Excel uploads

    location / {
        proxy_pass         http://127.0.0.1:5100;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Self-signed cert is fine for in-house QA; just trust it on dev machines.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Job stuck in "Waiting for a self-hosted runner" | Runner offline or wrong label | `sudo systemctl status actions.runner.*`; check `--labels qa-inhouse` was set during config |
| `npm run test:db` fails in deploy | Bad DB creds or VPN reset DB connectivity | SSH in, fix `.env`, re-run `npm run test:db` manually |
| Smoke test passes but app 500s on real requests | Stale env vars (PM2 didn't pick them up) | `pm2 reload easyfix-backend --update-env` |
| Runner registration token expired | One-time tokens are short-lived | Generate a new one in GitHub UI, re-run `./config.sh` |
| Need to remove the runner | About to decommission server | `sudo ./svc.sh stop && sudo ./svc.sh uninstall && ./config.sh remove --token <new-removal-token>` |

---

## Rollback — undoing everything we added

If anything we installed breaks another team's service, these commands
undo each step in reverse order. They only touch what WE added — they
never stop/remove pre-existing nginx, MySQL, Tomcat, etc.

```bash
# 1. Stop and unregister the GitHub runner (keeps the tarball, just stops polling)
cd /home/easyfix-deploy/actions-runner
sudo ./svc.sh stop
sudo ./svc.sh uninstall
# Generate a removal token in GitHub UI → Settings → Actions → Runners → "..."
sudo -u easyfix-deploy ./config.sh remove --token <REMOVAL_TOKEN>

# 2. Stop and disable PM2 on boot (per-user unit — does NOT touch other PM2s)
sudo systemctl disable --now pm2-easyfix-deploy

# 3. Kill the PM2 daemon + app for easyfix-deploy
sudo -iu easyfix-deploy pm2 kill

# 4. (Optional) Remove our nginx vhost — only the file WE added
sudo rm -f /etc/nginx/conf.d/easyfix-qa.conf
sudo nginx -t && sudo systemctl reload nginx     # verify before reload

# 5. Close our firewalld port (only if we opened it)
if firewall-cmd --zone=public --list-ports 2>/dev/null | grep -qw 5100/tcp; then
  sudo firewall-cmd --permanent --remove-port=5100/tcp
  sudo firewall-cmd --reload
fi

# 6. Restore CentOS yum mirrors (if the sed in 1.B.1 ran)
for f in /etc/yum.repos.d/CentOS-*.repo.bak; do
  [[ -f "$f" ]] && sudo mv "$f" "${f%.bak}"
done
sudo yum clean all

# 7. Deep-clean — ONLY do this when decommissioning. This removes the
#    deploy user, their home dir (including the repo, logs, nvm, runner,
#    and any uploaded files the app stored under /home/easyfix-deploy).
sudo userdel -r easyfix-deploy

# NOT rolled back by design:
# - libicu, curl, git, gcc (shared tools other teams may rely on)
# - system-wide nginx package (even if WE were the ones who installed it
#   — removing it risks breaking whoever's relying on it now)
# - SELinux boolean httpd_can_network_connect (rarely safe to flip off;
#   turn off only if you're certain nothing else depends on it)
```

Order matters: stop the runner (1) BEFORE killing PM2 (3) to avoid the
runner trying to deploy to a dead target mid-rollback.
