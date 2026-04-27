#!/usr/bin/env bash
#
# Deploy script for the QA in-house server (192.168.1.211).
#
# Invoked by .github/workflows/deploy-qa-inhouse.yml on the self-hosted
# runner that lives on the QA LAN. Idempotent — safe to re-run on the same
# commit and safe to invoke manually from an SSH session.
#
# Assumes:
#   * Live app dir lives at /home/easyfix-deploy/EasyFix_Backend
#   * easyfix-deploy user owns the dir + has pm2 installed for that user
#   * .env exists in the live app dir (NOT pulled from git — secrets!)
#   * ecosystem.config.js exists at the repo root
#
# Why we don't use the checkout the workflow already ran:
#   The workflow's `actions/checkout@v4` lands in $GITHUB_WORKSPACE which is
#   a per-job folder. We want a stable, long-lived app dir that PM2 watches
#   so a redeploy is just `git pull + npm ci + pm2 reload` — no symlink
#   shuffling, no risk of pm2 pointing at a stale path between runs.
#
set -euo pipefail

APP_DIR="${APP_DIR:-/home/easyfix-deploy/EasyFix_Backend}"
APP_USER="${APP_USER:-easyfix-deploy}"
BRANCH="${BRANCH:-QA}"
PM2_NAME="${PM2_NAME:-easyfix-backend}"

echo "▶ Deploying $BRANCH to $APP_DIR (running as $(whoami))"

# Run the rest as the app user — the runner itself runs as easyfix-deploy
# in the recommended setup, so this `sudo -u` is a no-op then. Keeps the
# script working from any shell, though.
run_as_app() {
  if [[ "$(whoami)" == "$APP_USER" ]]; then
    bash -se
  else
    sudo -u "$APP_USER" -H bash -se
  fi
}

run_as_app <<REMOTE
set -euo pipefail
cd "$APP_DIR"

echo "▶ Fetching latest from origin/$BRANCH"
git fetch --all --prune
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "▶ Installing production dependencies"
npm ci --omit=dev

echo "▶ Verifying DB connectivity BEFORE swapping traffic"
# test:db reads .env and does a SELECT 1 against easyfix_core. Failing here
# means we never touch the running PM2 process — the previous deploy keeps
# serving traffic until the next push.
npm run test:db

echo "▶ Reloading PM2 (zero-downtime)"
# `reload` does a graceful drain + replace; `restart` is a hard stop. Reload
# is safe for stateless HTTP services like ours.
pm2 reload "$PM2_NAME" --update-env

pm2 status "$PM2_NAME"
echo "✓ Deployed \$(git rev-parse --short HEAD) at \$(date -u +%FT%TZ)"
REMOTE
