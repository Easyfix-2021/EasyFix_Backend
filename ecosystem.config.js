/*
 * PM2 process definition for the EasyFix unified backend.
 *
 * Two deployment targets share this file:
 *   1. AWS EC2 (deploy.yml) — staging + production
 *   2. QA in-house server (deploy-qa-inhouse.yml) — single instance on the LAN
 *
 * Single-instance for now (no cluster mode):
 *   The app is stateless HTTP + a mysql2 pool, so cluster mode would scale
 *   horizontally. We start with `instances: 1` because the auto-assign
 *   pipeline batches DB queries and we don't want N parallel pools fanning
 *   out against the shared 384k-row tbl_job until we've measured contention.
 *   Switch to `instances: 'max', exec_mode: 'cluster'` once we have load
 *   data — it's a single-line change with no app-side code impact.
 */
module.exports = {
  apps: [{
    name: 'easyfix-backend',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',

    // Memory ceiling — autoscale-ish safety net. If the process leaks past
    // 700 MB, pm2 restarts it. Tune up if Node's working set legitimately
    // grows past this (e.g. xlsx upload of 50 MB sheets stays in heap).
    max_memory_restart: '700M',

    // Don't enter a restart loop when the app crashes immediately — most
    // likely a bad deploy / missing env var, not a transient error. Logs
    // tell us what's wrong; restart loops spam alerts.
    autorestart: true,
    min_uptime: '15s',
    max_restarts: 10,
    restart_delay: 5000,

    env: {
      NODE_ENV: 'production',
      // Everything else (DB creds, JWT_SECRET, MS_GRAPH_*, NOTIFICATIONS_DISABLE,
      // TEST_EMAILS, etc.) is sourced from .env via dotenv at server.js boot.
      // Don't put secrets here — this file is committed.
    },

    // Rotated logs land in ~/.pm2/logs/. Use `pm2 install pm2-logrotate`
    // on the host once to enable size-based rotation (default 10 MB / file).
    out_file: './logs/out.log',
    error_file: './logs/err.log',
    merge_logs: true,
    time: true, // prefix each log line with ISO timestamp
  }],
};
