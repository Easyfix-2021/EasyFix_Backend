#!/usr/bin/env bash
# ============================================================================
# QA In-house Pre-flight Audit
#
# Run this on 192.168.1.211 BEFORE the setup steps in
# docs/QA_INHOUSE_DEPLOYMENT.md. It only READS — never installs, changes
# config, or stops services. The output tells you whether any setup step
# will collide with something already on the box.
#
# Usage (as root):
#   bash /tmp/qa-preflight.sh
#
# Exit code is always 0; conflicts are reported in-line with ✗ markers.
# ============================================================================

set -uo pipefail   # NOT -e: we want to keep auditing after a failing check

RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); NC=$(printf '\033[0m')
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
bad()  { echo "${RED}✗${NC} $*"; }

section() { echo; echo "── $* ──────────────────────────────────"; }

section "Host identity"
echo "hostname    = $(hostname)"
echo "kernel      = $(uname -r)"
echo "os-release  = $(awk -F= '/^PRETTY_NAME/ {gsub(/"/,"",$2); print $2}' /etc/os-release)"
echo "uptime      = $(uptime -p 2>/dev/null || uptime)"

section "Users & groups"
if id easyfix-deploy &>/dev/null; then
  warn "user 'easyfix-deploy' already exists — reuse or pick a different user; do NOT 'userdel' without archiving \$HOME first"
  getent passwd easyfix-deploy
else
  ok "user 'easyfix-deploy' not present — safe to create"
fi

section "Ports in use (the ones our setup wants)"
for port in 80 443 5100 5180 3306 3900; do
  pid=$(ss -ltnp 2>/dev/null | awk -v P=":$port" '$4 ~ P {print $6}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  if [[ -n "$pid" ]]; then
    proc=$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")
    bad  "port $port is in use by PID $pid ($proc) — DO NOT reassign without checking with the owning team"
  else
    ok   "port $port free"
  fi
done

section "Existing services we might collide with"
for svc in nginx httpd mysqld mariadb tomcat pm2-easyfix-deploy actions.runner docker containerd; do
  if systemctl list-units --type=service --all 2>/dev/null | grep -q "^[[:space:]]*${svc}"; then
    state=$(systemctl is-active "$svc" 2>/dev/null)
    enab=$(systemctl is-enabled "$svc" 2>/dev/null)
    warn "systemd unit '$svc' present (active=$state enabled=$enab) — review before yum install/restart"
  fi
done

section "Nginx state (if installed)"
if command -v nginx &>/dev/null; then
  nginx -v 2>&1 | sed 's/^/  /'
  if nginx -T &>/dev/null; then
    echo "  vhosts currently loaded:"
    nginx -T 2>/dev/null | awk '/server_name/ {print "    "$0}' | sort -u | head -20
    ok "nginx config valid — our setup should ONLY add a new file under /etc/nginx/conf.d/, never overwrite nginx.conf or existing vhosts"
  else
    bad "nginx -T failed — existing config is broken; do not restart nginx until that's fixed"
  fi
else
  ok "nginx not installed — 'yum install nginx' is safe to run"
fi

section "Node / npm / nvm already present?"
command -v node &>/dev/null && warn "system-wide 'node' = $(node --version) ($(command -v node)) — our setup uses nvm under easyfix-deploy's HOME, does NOT touch this"
command -v npm  &>/dev/null && echo "system-wide 'npm' = $(npm --version)"
command -v pm2  &>/dev/null && warn "system-wide 'pm2' = $(pm2 --version) at $(command -v pm2) — if another team's PM2 already runs, we'll run a SEPARATE PM2 under easyfix-deploy"
[[ -d /home/*/.nvm ]] 2>/dev/null && warn "another user already has nvm installed — harmless, we'll install a separate copy under easyfix-deploy"

section "MySQL / MariaDB client (for test:db)"
if command -v mysql &>/dev/null; then
  ok "mysql client found: $(mysql --version)"
else
  warn "no mysql client — 'npm run test:db' uses node-mysql2 so this is optional, but handy for adhoc debugging"
fi

section "Firewall"
if systemctl is-active firewalld &>/dev/null; then
  ok "firewalld running"
  echo "  zones: $(firewall-cmd --get-active-zones 2>/dev/null | head -4 | tr '\n' ' ')"
  echo "  open ports (public zone): $(firewall-cmd --zone=public --list-ports 2>/dev/null)"
else
  warn "firewalld not active — if iptables is in use instead, coordinate with sysadmin before opening 5100"
fi

section "SELinux"
if command -v getenforce &>/dev/null; then
  mode=$(getenforce)
  echo "  mode = $mode"
  [[ "$mode" == "Enforcing" ]] && warn "SELinux Enforcing — if nginx needs to proxy to Node on 5100, 'setsebool -P httpd_can_network_connect 1' may be required. Check httpd_can_network_connect first: $(getsebool httpd_can_network_connect 2>/dev/null || echo unknown)"
fi

section "Disk space (install needs ~500 MB for node_modules + runner)"
df -hP /home / 2>/dev/null | awk 'NR==1 || /\/home|^\S+ +[0-9]+.*\/$/'

section "Yum repositories (CentOS 7 EOL — sed will add vault mirrors)"
if grep -l 'mirror.centos.org' /etc/yum.repos.d/CentOS-*.repo 2>/dev/null >/dev/null; then
  warn "CentOS-*.repo files still point at mirror.centos.org (EOL). Our sed creates .bak backups — restore with: for f in /etc/yum.repos.d/CentOS-*.repo.bak; do mv \"\$f\" \"\${f%.bak}\"; done"
fi
ls /etc/yum.repos.d/ | sort | sed 's/^/  /'

section "Outgoing connectivity (needs to reach github.com for runner + pulls)"
for url in https://github.com https://api.github.com https://registry.npmjs.org; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || echo TIMEOUT)
  [[ "$code" =~ ^[23] ]] && ok "$url → $code" || bad "$url → $code (workflow runner needs outbound HTTPS to fetch its jobs)"
done

echo
echo "Done. Review any ${RED}✗${NC} or ${YELLOW}!${NC} lines above before proceeding with setup."
