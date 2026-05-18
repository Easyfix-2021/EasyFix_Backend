const router = require('express').Router();

const validate = require('../../middleware/validate');
const job = require('../../services/job.service');
const candidateRanking = require('../../services/candidate-ranking.service');
const { modernOk, modernError } = require('../../utils/response');
const {
  listQuery, createBody, updateBody, statusBody, assignBody, ownerBody, idParam,
} = require('../../validators/job.validator');
const { assertEntityInScope } = require('../../lib/scope');
const { streamStyledXlsx } = require('../../utils/xlsx-styled-export');

/*
 * Row-level scope guard for every /:id endpoint. Fetches the job once,
 * confirms (client_id, city_id, vertical_id) all sit within the caller's
 * manage_* scope. Returns 404 (not 403) on scope failure to avoid leaking
 * existence of out-of-scope job_ids. Attaches the row at req.scopedJob
 * so downstream handlers can use it without a second fetch.
 */
async function scopedJob(req, res, next) {
  try {
    const j = await job.getById(req.params.id);
    if (!j) return modernError(res, 404, 'job not found');
    const guard = assertEntityInScope(req, {
      client_id:   j.fk_client_id,
      city_id:     j.city_id,
      vertical_id: j.vertical_id,
    });
    if (!guard.ok) return modernError(res, 404, 'job not found');
    req.scopedJob = j;
    return next();
  } catch (e) { next(e); }
}

// Upload sub-router (POST /upload) — isolated because of multer middleware.
router.use(require('./jobs-upload'));

/*
 * GET /api/admin/jobs/:id/candidates?limit=50
 *
 * Returns ranked technicians for the Assign / Reassign modal on /my-orders
 * and /jobs. Same layered pipeline used by on-create auto-assign — see
 * services/candidate-ranking.service.js. Returns per-candidate breakdowns
 * (Rating, TAT, SDA, Worked-for-Client, Worked-for-Vertical, Attendance)
 * plus account balance for sorting tie-break.
 *
 * If no technician passes the deep-skill filter, the response includes
 * `note: 'no_deep_skill_match'` and the candidates list is the same query
 * with the skill predicate dropped — so the modal can show a banner and
 * still let ops pick someone.
 *
 * Listed BEFORE `/:id/assign` and other `/:id/*` so Express matches the
 * literal `candidates` segment first.
 */
router.get('/:id/candidates', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const result = await candidateRanking.rankCandidatesForJob(req.params.id, { limit });
    modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    // Row-level RBAC + reporting hierarchy: row-filter the list by the
    // UNION of (caller's own manage_* scope) ∪ (every direct/indirect
    // report's manage_* scope). Admin/Finance bypass via the bypass
    // list in lib/scope.js.
    const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
    const { pool } = require('../../db');
    const scope = await buildRequestScopeWithHierarchy(req, pool);
    const { rows, total } = await job.list({ ...req.query, scope });
    modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/counts
 * Returns status-bucket totals + grand total in ONE query. Replaces the
 * dashboard's 6 parallel list-with-limit-1 calls (which each spent 2 DB
 * connections on COUNT + data queries — ~12 concurrent connections just for
 * stats, enough to saturate a 20-connection pool when combined with /auth/me
 * and recent-jobs on the same page load). Single GROUP BY = 1 connection.
 */
/*
 * Accepts optional `?ownerId=<user_id>` to scope the buckets to jobs owned
 * by that user (drives the "My Orders" sidebar flow on the CRM). Invalid or
 * missing ownerId falls through to org-wide counts — same response shape,
 * different WHERE clause. Frontend passes `ownerId = currentUser.user_id`
 * when it detects `?scope=mine` on the URL.
 */
router.get('/counts', async (req, res, next) => {
  try {
    const ownerId = req.query.ownerId ? Number(req.query.ownerId) : undefined;
    // Dashboard cards must respect the caller's RBAC scope (hierarchy-
    // unioned). req.scope is attached by the global admin middleware
    // (routes/admin/index.js). Admin/Finance get undefined → no row filter.
    const counts = await job.getStatusCounts({
      ownerId: Number.isFinite(ownerId) ? ownerId : undefined,
      scope: req.scope,
    });
    modernOk(res, counts);
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/escalated
 *
 * Ported from legacy ACD action `getEscalatedJobs` (JobDaoImpl.java:4690).
 * Returns the same enriched shape the Angular Client Dashboard's
 * "Escalated Jobs" modal renders.
 *
 * Data sources (verified against legacy SQL):
 *   - tbl_easyfixer_rating_by_customer (alias e)  : the canonical
 *       escalation record. Columns: table_id, job_id, easyfixer_id,
 *       is_escalated (0/1), escalated_by (user_id FK), escalated_time,
 *       resolved_time, escalated_comments, no_of_escalations,
 *       escalated_from, completed_action, inprogress_action,
 *       closed_action, escalation_closed_time.
 *   - tbl_job_escalation_info (alias i)           : per-stage history.
 *       Aggregated into job_stage (CSV of "date + stage") so each row
 *       shows where the job sat at each escalation moment.
 *   - tbl_job (j), tbl_address (a), tbl_city (c), tbl_client (cl),
 *     tbl_user (u) — joined for client name, city, owner, etc.
 *
 * Filter param `status` ∈ {open, closed, pending}:
 *   - open    : escalated_time IS NOT NULL AND
 *               (resolved_time IS NULL OR escalated_time > resolved_time
 *                OR closed_action = 16)
 *   - closed  : escalated_time + resolved_time + escalation_closed_time
 *               all NOT NULL AND closed_action != 16
 *   - pending : escalated > resolved, no closed_action=15
 *
 * RBAC: respects req.scope (clients × cities × verticals).
 */
router.get('/escalated', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'open').toLowerCase();
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const clauses = ['e.is_escalated = 1', 'e.escalated_time IS NOT NULL'];
    const params = [];

    if (status === 'open') {
      clauses.push('(e.resolved_time IS NULL OR e.escalated_time > e.resolved_time OR e.closed_action = 16)');
    } else if (status === 'closed') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalation_closed_time IS NOT NULL');
      clauses.push('(e.closed_action IS NULL OR e.closed_action != 16)');
    } else if (status === 'pending') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalated_time < e.resolved_time');
      clauses.push('(e.escalation_closed_time IS NULL OR e.closed_action != 15)');
    }

    if (q) {
      clauses.push('(j.job_id = ? OR cl.client_name LIKE ? OR c.city_name LIKE ?)');
      params.push(Number(q) || 0, `%${q}%`, `%${q}%`);
    }

    // RBAC scope — same shape as the main list. We only filter when scope
    // is set; Admin/Finance bypass via the lib/scope.js bypass list.
    const sc = req.scope;
    if (sc) {
      if (sc.clients) {
        if (sc.clients.mode === 'none') clauses.push('1=0');
        else if (sc.clients.mode === 'allow' && sc.clients.ids.length) {
          clauses.push(`j.fk_client_id IN (${sc.clients.ids.map(() => '?').join(',')})`);
          params.push(...sc.clients.ids);
        }
      }
      if (sc.cities) {
        if (sc.cities.mode === 'none') clauses.push('1=0');
        else if (sc.cities.mode === 'allow' && sc.cities.ids.length) {
          clauses.push(`a.city_id IN (${sc.cities.ids.map(() => '?').join(',')})`);
          params.push(...sc.cities.ids);
        }
      }
      if (sc.verticals) {
        if (sc.verticals.mode === 'none') clauses.push('1=0');
        else if (sc.verticals.mode === 'allow' && sc.verticals.ids.length) {
          // Guarded: only emit the WHERE clause when tbl_client.vertical_id
          // actually exists on this DB. Same probe as services/job.service.js.
          if (await job.hasClientVerticalIdColumn()) {
            clauses.push(`cl.vertical_id IN (${sc.verticals.ids.map(() => '?').join(',')})`);
            params.push(...sc.verticals.ids);
          }
        }
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // Aggregated job_stage subquery — for each job, concatenates every
    // (escalation_time, job_stage) pair from tbl_job_escalation_info.
    // Mirrors the legacy group_concat in JobDaoImpl line 4705.
    const baseFrom = `
      FROM tbl_easyfixer_rating_by_customer e
      LEFT JOIN tbl_job     j  ON j.job_id = e.job_id
      LEFT JOIN tbl_address a  ON a.address_id = j.fk_address_id
      LEFT JOIN tbl_city    c  ON c.city_id = a.city_id
      LEFT JOIN tbl_client  cl ON cl.client_id = j.fk_client_id
      LEFT JOIN tbl_user    u  ON u.user_id = e.escalated_by
      LEFT JOIN (
        SELECT job_id,
               GROUP_CONCAT(
                 CONCAT(
                   DATE_FORMAT(escalation_time, '%d %M %Y %h:%i %p'),
                   ' · ', COALESCE(job_stage, '—')
                 )
                 ORDER BY escalation_time
                 SEPARATOR ' / '
               ) AS job_stage_history
          FROM tbl_job_escalation_info
         GROUP BY job_id
      ) j1 ON j1.job_id = j.job_id
    `;

    const { pool } = require('../../db');
    const [rows] = await pool.query(
      `SELECT
         e.table_id, e.job_id, j.job_status, j.fk_easyfixter_id,
         e.escalated_time, e.resolved_time, e.escalation_closed_time,
         e.escalated_by, u.user_name AS escalated_by_name,
         e.escalated_comments, e.no_of_escalations, e.escalated_from,
         e.closed_action, e.completed_action, e.inprogress_action,
         j.requested_date_time, j.job_reference_id, j.client_ref_id, j.sub_job_id,
         cl.client_name, c.city_name,
         j1.job_stage_history
       ${baseFrom}
       ${where}
       ORDER BY e.escalated_time DESC, e.table_id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${baseFrom} ${where}`, params
    );
    modernOk(res, { items: rows, total, limit, offset });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/escalated/export.xlsx
 *
 * Styled XLSX export of the escalated-jobs list. Same SQL as the list
 * endpoint above (JOINs + status filter + RBAC scope) — only the
 * pagination is dropped: the export always returns the entire status-
 * filtered set up to a 5,000-row safety ceiling.
 *
 * Filter param `status` ∈ {open, closed, pending}. Free-text `q` is
 * intentionally NOT honoured here — the FE search box is a UI-only
 * filter over the loaded page (matches the CallInfoModal contract:
 * "exports reflect the dataset the operator asked the BACKEND for,
 * not the in-table search").
 *
 * Output shape is hand-translated for readability — action enums →
 * human labels, escalated duration humanised, date/time split into
 * two columns. The styled workbook uses the shared
 * utils/xlsx-styled-export recipe so the brand band, header band, and
 * row banding match Call History.
 */
router.get('/escalated/export.xlsx', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'open').toLowerCase();

    const clauses = ['e.is_escalated = 1', 'e.escalated_time IS NOT NULL'];
    const params = [];

    if (status === 'open') {
      clauses.push('(e.resolved_time IS NULL OR e.escalated_time > e.resolved_time OR e.closed_action = 16)');
    } else if (status === 'closed') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalation_closed_time IS NOT NULL');
      clauses.push('(e.closed_action IS NULL OR e.closed_action != 16)');
    } else if (status === 'pending') {
      clauses.push('e.resolved_time IS NOT NULL');
      clauses.push('e.escalated_time < e.resolved_time');
      clauses.push('(e.escalation_closed_time IS NULL OR e.closed_action != 15)');
    }

    // Same RBAC clauses as the list endpoint — keep these in sync if
    // either is ever changed. (Pulling into a helper is overkill until
    // a third escalation route appears.)
    const sc = req.scope;
    if (sc) {
      if (sc.clients) {
        if (sc.clients.mode === 'none') clauses.push('1=0');
        else if (sc.clients.mode === 'allow' && sc.clients.ids.length) {
          clauses.push(`j.fk_client_id IN (${sc.clients.ids.map(() => '?').join(',')})`);
          params.push(...sc.clients.ids);
        }
      }
      if (sc.cities) {
        if (sc.cities.mode === 'none') clauses.push('1=0');
        else if (sc.cities.mode === 'allow' && sc.cities.ids.length) {
          clauses.push(`a.city_id IN (${sc.cities.ids.map(() => '?').join(',')})`);
          params.push(...sc.cities.ids);
        }
      }
      if (sc.verticals) {
        if (sc.verticals.mode === 'none') clauses.push('1=0');
        else if (sc.verticals.mode === 'allow' && sc.verticals.ids.length) {
          // Guarded: only emit the WHERE clause when tbl_client.vertical_id
          // actually exists on this DB. Same probe as services/job.service.js.
          if (await job.hasClientVerticalIdColumn()) {
            clauses.push(`cl.vertical_id IN (${sc.verticals.ids.map(() => '?').join(',')})`);
            params.push(...sc.verticals.ids);
          }
        }
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const baseFrom = `
      FROM tbl_easyfixer_rating_by_customer e
      LEFT JOIN tbl_job     j  ON j.job_id = e.job_id
      LEFT JOIN tbl_address a  ON a.address_id = j.fk_address_id
      LEFT JOIN tbl_city    c  ON c.city_id = a.city_id
      LEFT JOIN tbl_client  cl ON cl.client_id = j.fk_client_id
      LEFT JOIN tbl_user    u  ON u.user_id = e.escalated_by
      LEFT JOIN (
        SELECT job_id,
               GROUP_CONCAT(
                 CONCAT(
                   DATE_FORMAT(escalation_time, '%d %M %Y %h:%i %p'),
                   ' · ', COALESCE(job_stage, '—')
                 )
                 ORDER BY escalation_time
                 SEPARATOR ' / '
               ) AS job_stage_history
          FROM tbl_job_escalation_info
         GROUP BY job_id
      ) j1 ON j1.job_id = j.job_id
    `;

    const { pool } = require('../../db');
    const [rows] = await pool.query(
      `SELECT
         e.table_id, e.job_id, j.job_status, j.fk_easyfixter_id,
         e.escalated_time, e.resolved_time, e.escalation_closed_time,
         e.escalated_by, u.user_name AS escalated_by_name,
         e.escalated_comments, e.no_of_escalations, e.escalated_from,
         e.closed_action, e.completed_action, e.inprogress_action,
         j.requested_date_time,
         cl.client_name, c.city_name,
         j1.job_stage_history
       ${baseFrom}
       ${where}
       ORDER BY e.escalated_time DESC, e.table_id DESC
       LIMIT 5000`,
      params
    );

    // Enum-to-label maps mirror the FE's TEAM_ACTIONS / COMPLETED_ACTIONS /
    // CLOSED_ACTIONS in EscalatedJobsModal.tsx. If either list changes,
    // both ends need updating — the values are stamped legacy enums
    // from escalateSearchResult.vm so they shouldn't drift.
    const TEAM_LABEL = {
      1: 'Easy Fixer is Scheduled',
      2: 'Convinced Customer For New Date',
      3: 'Pending from client',
      4: 'Fake Reschedule & OTA expected',
      5: 'Customer Reschedule',
    };
    const COMPLETED_LABEL = {
      11: 'Work Completed',
      12: 'Grievance Resolved & on-the-same-page',
    };
    const CLOSED_LABEL = { 15: 'Resolved', 16: 'Re-Open' };
    const STATUS_LABEL = {
      0: 'Booked', 1: 'Scheduled', 2: 'In Progress',
      3: 'Completed', 5: 'Completed', 6: 'Cancelled',
      7: 'Enquiry', 9: 'Unconfirmed', 10: 'Revisit',
      15: 'Estimate Pending', 20: 'Pending to Close', 21: 'Followup',
    };

    // Humanise an ISO/MySQL DATETIME → "29 Apr 2026" and "10:07 am"
    // pieces so the XLSX shows the same two-line layout the modal does.
    function dateOnly(d) {
      if (!d) return '';
      const dt = new Date(d);
      if (Number.isNaN(+dt)) return String(d);
      return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    function timeOnly(d) {
      if (!d) return '';
      const dt = new Date(d);
      if (Number.isNaN(+dt)) return '';
      return dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
    }
    function durationLabel(start, end) {
      if (!start) return '';
      const s = new Date(start);
      if (Number.isNaN(+s)) return '';
      const e = end ? new Date(end) : new Date();
      const ms = Math.max(0, +e - +s);
      const totalMins = Math.floor(ms / 60000);
      const days = Math.floor(totalMins / (60 * 24));
      const hours = Math.floor((totalMins % (60 * 24)) / 60);
      const mins = totalMins % 60;
      if (days > 0) return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
      if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ${mins} min${mins === 1 ? '' : 's'}`;
      return `${mins} min${mins === 1 ? '' : 's'}`;
    }

    const xlsxRows = rows.map((r) => ({
      date_escalated:  dateOnly(r.escalated_time),
      time_escalated:  timeOnly(r.escalated_time),
      job_id:          r.job_id ?? '',
      client:          r.client_name || '',
      city:            r.city_name || '',
      job_stage:       r.job_stage_history || '',
      current_status:  r.job_status != null
        ? (STATUS_LABEL[r.job_status] || `Status ${r.job_status}`)
        : '',
      no_of_escal:     r.no_of_escalations ?? 0,
      escalated_from:  r.escalated_from || '',
      reason:          r.escalated_comments || '',
      escalated_by:    r.escalated_by_name || '',
      team_action:      TEAM_LABEL[r.inprogress_action] || '',
      completed_action: COMPLETED_LABEL[r.completed_action] || '',
      closed_action:    CLOSED_LABEL[r.closed_action] || '',
      escalated_hours:  durationLabel(r.escalated_time, r.resolved_time),
      orig_appt_date:   r.requested_date_time ? dateOnly(r.requested_date_time) : '',
      orig_appt_time:   r.requested_date_time ? timeOnly(r.requested_date_time) : '',
      reopened:         (r.no_of_escalations ?? 0) > 1 ? 'Yes' : '',
    }));

    const today = new Date().toISOString().slice(0, 10);
    const statusTitle = status.charAt(0).toUpperCase() + status.slice(1);
    const meta = [
      `Status: ${statusTitle}`,
      `Generated: ${new Date().toLocaleString('en-IN')}`,
      `Total: ${xlsxRows.length} escalation${xlsxRows.length === 1 ? '' : 's'}`,
    ].join('    ·    ');

    await streamStyledXlsx(res, `escalated-jobs_${status}_${today}.xlsx`, {
      title: 'EasyFix  ·  Escalated Jobs',
      meta,
      sheetName: 'Escalated Jobs',
      columns: [
        { header: 'Date Escalated',          key: 'date_escalated',   width: 14, align: 'left' },
        { header: 'Time Escalated',          key: 'time_escalated',   width: 12, align: 'center' },
        { header: 'Job ID',                  key: 'job_id',           width: 10, align: 'center' },
        { header: 'Client',                  key: 'client',           width: 24, align: 'left' },
        { header: 'City',                    key: 'city',             width: 16, align: 'left' },
        { header: 'Job Stage',               key: 'job_stage',        width: 42, align: 'left' },
        { header: 'Current Status',          key: 'current_status',   width: 14, align: 'center' },
        { header: 'No of Escalations',       key: 'no_of_escal',      width: 12, align: 'center' },
        { header: 'Escalated From',          key: 'escalated_from',   width: 16, align: 'left' },
        { header: 'Reason For Escalation',   key: 'reason',           width: 42, align: 'left' },
        { header: 'Escalated By',            key: 'escalated_by',     width: 20, align: 'left' },
        { header: 'Team Action',             key: 'team_action',      width: 28, align: 'left' },
        { header: 'Completed Action',        key: 'completed_action', width: 30, align: 'left' },
        { header: 'Closed Action',           key: 'closed_action',    width: 14, align: 'center' },
        { header: 'Escalated Hours',         key: 'escalated_hours',  width: 18, align: 'left' },
        { header: 'Original Appointment Date', key: 'orig_appt_date', width: 14, align: 'left' },
        { header: 'Original Appointment Time', key: 'orig_appt_time', width: 12, align: 'center' },
        { header: 'Reopened',                key: 'reopened',         width: 10, align: 'center' },
      ],
      rows: xlsxRows,
      emptyMessage: `No ${status} escalations found.`,
    });
  } catch (e) { next(e); }
});

/*
 * PATCH /api/admin/jobs/escalated/:tableId
 *
 * Updates one escalation workflow row (`tbl_easyfixer_rating_by_customer`).
 * Drives the inline Team Action / Completed Action / Closed Action +
 * Comment controls in the EscalatedJobsModal. Allowed fields:
 *
 *   inprogress_action : 1..5 (Team Action enum, legacy values from
 *                       escalateSearchResult.vm:64-71)
 *   completed_action  : 11..12 (Completed Action enum)
 *   closed_action     : 15 (Resolved) | 16 (Re-Open)
 *   escalated_comments: free text appended/replaced (legacy let
 *                       supply team add an inline comment per row)
 *
 * When closed_action transitions to 15 (Resolved), also stamp
 * escalation_closed_time = NOW(). When set to 16 (Re-Open), clear
 * the closed_time so the row goes back to the "open" filter.
 */
router.patch('/escalated/:tableId', async (req, res, next) => {
  try {
    const { pool } = require('../../db');
    const tableId = Number(req.params.tableId);
    if (!Number.isInteger(tableId) || tableId <= 0) {
      return modernError(res, 400, 'invalid tableId');
    }
    const sets = [];
    const params = [];
    const b = req.body || {};

    // Team Action — `inprogress_action` column.
    if (b.inprogress_action !== undefined) {
      const v = Number(b.inprogress_action);
      if (!Number.isInteger(v) || v < 0 || v > 5) {
        return modernError(res, 400, 'inprogress_action must be 0..5');
      }
      sets.push('inprogress_action = ?');
      params.push(v || null);
    }
    // Completed Action.
    if (b.completed_action !== undefined) {
      const v = Number(b.completed_action);
      if (!Number.isInteger(v) || (v !== 0 && v !== 11 && v !== 12)) {
        return modernError(res, 400, 'completed_action must be 11 or 12');
      }
      sets.push('completed_action = ?');
      params.push(v || null);
    }
    // Closed Action — also stamps / clears escalation_closed_time.
    if (b.closed_action !== undefined) {
      const v = Number(b.closed_action);
      if (!Number.isInteger(v) || (v !== 0 && v !== 15 && v !== 16)) {
        return modernError(res, 400, 'closed_action must be 15 (Resolved) or 16 (Re-Open)');
      }
      sets.push('closed_action = ?');
      params.push(v || null);
      if (v === 15) {
        sets.push('escalation_closed_time = NOW()');
        // also mark resolved_time so the "closed" filter picks it up
        sets.push('resolved_time = COALESCE(resolved_time, NOW())');
      } else if (v === 16) {
        // Re-Open: clear closed_time + bump no_of_escalations so the
        // row falls back into the "open" filter. Legacy did the same.
        sets.push('escalation_closed_time = NULL');
        sets.push('no_of_escalations = COALESCE(no_of_escalations, 0) + 1');
        sets.push('escalated_time = NOW()');
      }
    }
    if (b.escalated_comments !== undefined) {
      const txt = String(b.escalated_comments || '').slice(0, 2000);
      sets.push('escalated_comments = ?');
      params.push(txt || null);
    }
    if (sets.length === 0) {
      return modernError(res, 400, 'no editable fields supplied');
    }
    params.push(tableId);
    const [r] = await pool.query(
      `UPDATE tbl_easyfixer_rating_by_customer SET ${sets.join(', ')} WHERE table_id = ?`,
      params
    );
    if (r.affectedRows === 0) {
      return modernError(res, 404, 'escalation row not found');
    }
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/jobs/action-reasons?type=<unreachable|enquiry>
 *
 * Drives the dropdown inside the Book-New-Call "Job Unreachable" /
 * "Job Enquiry" popup (legacy CRM parity). Reasons come from
 * `action_taken_reason` joined to `action_type`.
 *
 * Schema (verified 2026-05-18 against easyfix DB):
 *   action_type         { id, type ("Un Reachable"|"Enquiry"|...), description }
 *   action_taken_reason { id, action_type (FK→action_type.id), action_desc,
 *                         status (1=active), user_type, is_new }
 *
 * Route-order note: declared BEFORE `/:id` so Express doesn't try to
 * validate the literal string "action-reasons" as a numeric job id —
 * same gotcha as `/bulk` vs `/:jobId` in routes/admin/auto-assign.js.
 */
router.get('/action-reasons', async (req, res, next) => {
  try {
    const type = String(req.query.type || '').trim().toLowerCase();
    if (!type) return modernError(res, 400, 'type is required (unreachable|enquiry)');

    // Strip spaces/underscores/dashes on both sides so the URL token
    // "unreachable" matches the DB value "Un Reachable", "enquiry"
    // matches "Enquiry", etc.
    const needle = type.replace(/[\s_-]/g, '');
    const [typeRows] = await pool.query(
      `SELECT id, type FROM action_type
        WHERE LOWER(REPLACE(REPLACE(REPLACE(type, ' ', ''), '_', ''), '-', '')) = ?
        ORDER BY id DESC LIMIT 1`,
      [needle],
    );
    if (!typeRows.length) return modernOk(res, []);
    const typeId = typeRows[0].id;

    const [reasonRows] = await pool.query(
      `SELECT id, action_desc FROM action_taken_reason
        WHERE action_type = ? AND (status IS NULL OR status = 1)
        ORDER BY id ASC`,
      [typeId],
    );
    const items = reasonRows
      .map((r) => ({ id: r.id, label: String(r.action_desc || '').trim() }))
      .filter((x) => x.label);
    modernOk(res, items);
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), scopedJob, async (req, res) => {
  modernOk(res, req.scopedJob);
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    // Scope check on create: caller can only create jobs for a client/city
    // within their manage_* scope. Same guard runs on subsequent edits via
    // the `scopedJob` middleware.
    const guard = assertEntityInScope(req, {
      client_id: req.body.fk_client_id,
      city_id:   req.body.address?.city_id,
    });
    if (!guard.ok) return modernError(res, 403, 'cannot create a job outside your assigned scope');
    const created = await job.create(req.body, req.user);
    res.status(201);
    modernOk(res, created, 'job created');
  } catch (e) { next(e); }
});

/*
 * Update — exposed as BOTH PUT and PATCH to the same handler. The CRM_UI
 * edit flow uses PATCH semantically (partial update) while some integration
 * callers use PUT; both land on the same validator + service call so we
 * don't fork behaviour.
 */
const updateHandler = async (req, res, next) => {
  try {
    const updated = await job.update(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job updated');
  } catch (e) { next(e); }
};
router.put('/:id',   validate(idParam, 'params'), validate(updateBody), scopedJob, updateHandler);
router.patch('/:id', validate(idParam, 'params'), validate(updateBody), scopedJob, updateHandler);

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), scopedJob, async (req, res, next) => {
  try {
    const updated = await job.setStatus(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job status updated');
  } catch (e) { next(e); }
});

router.patch('/:id/assign', validate(idParam, 'params'), validate(assignBody), scopedJob, async (req, res, next) => {
  try {
    const updated = await job.assign(req.params.id, req.body, req.user);
    modernOk(res, updated, 'technician assigned');
  } catch (e) { next(e); }
});

router.patch('/:id/owner', validate(idParam, 'params'), validate(ownerBody), scopedJob, async (req, res, next) => {
  try {
    const updated = await job.changeOwner(req.params.id, req.body, req.user);
    modernOk(res, updated, 'job owner changed');
  } catch (e) { next(e); }
});

// ─── Fulfillment hold ───────────────────────────────────────────────
// Mirrors legacy `addEditFullFillmentHold` + `confirmFullfillmentHold`.
//
// VERIFIED tbl_job columns (JobDaoImpl.java:4587):
//   full_fillment_reason, full_fillment_time, full_fillment_by,
//   full_fillment_created_time, no_of_req_foh, job_status
//
// State machine:
//   PUT  /jobs/:id/hold     → job_status = 21, stamp hold fields,
//                              increment no_of_req_foh
//   POST /jobs/:id/hold/release → job_status = 10 (REVISIT)
const { pool } = require('../../db');
const holdBody = require('joi').object({
  reason: require('joi').string().trim().min(1).max(500).required(),
  appointment_time: require('joi').date().iso().required(),
});
router.put('/:id/hold', validate(idParam, 'params'), validate(holdBody), scopedJob, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE tbl_job
          SET job_status = 21,
              full_fillment_reason = ?,
              full_fillment_time = ?,
              full_fillment_by = ?,
              full_fillment_created_time = NOW(),
              no_of_req_foh = COALESCE(no_of_req_foh, 0) + 1
        WHERE job_id = ?`,
      [req.body.reason, req.body.appointment_time, req.user.user_id, req.params.id]
    );
    modernOk(res, { on_hold: true, status: 21 });
  } catch (e) { next(e); }
});
router.post('/:id/hold/release', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    await pool.query('UPDATE tbl_job SET job_status = 10 WHERE job_id = ?', [req.params.id]);
    modernOk(res, { released: true, status: 10 });
  } catch (e) { next(e); }
});

// ─── Multi-step estimate approval workflow ──────────────────────────
// Mirrors legacy JobAction.java `requestApproval` (preview) +
// `confirmApprovejob` (send-for-approval) pair.
//
// VERIFIED tbl_job columns (JobDaoImpl.java:2473 + 4587):
//   approve_job_doc, approval_sent_on_date_time, no_of_req_approval
//
// Two steps:
//   GET  /admin/jobs/:id/estimate/preview         — service breakdown + grand total
//   POST /admin/jobs/:id/estimate/send-for-approval — stamp approval_sent_on_date_time,
//                                                     job_status = 15, increment counter,
//                                                     email PDF to client SPOC
//
// PDF generation reuses `utils/pdf-invoice.js` rendering style but
// produces an estimate-approval doc. For now we send a plain-text
// email with the estimate breakdown; PDF attachment can be wired
// when ops requests it (the SP and audit trail are already in place).
const emailServiceForJobs = require('../../services/email.service');
router.get('/:id/estimate/preview', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    const [services] = await pool.query(
      `SELECT js.job_service_id, js.quantity, js.total_charge, js.material_charge,
              CR.crc_ratecard_name AS service_name
         FROM tbl_job_services js
         LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
         LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
        WHERE js.job_id = ? AND js.job_service_status = 1
        ORDER BY js.job_service_id`,
      [jobId]
    );
    const lines = services.map((s) => ({
      ...s,
      line_total: Number(s.total_charge || 0) * Number(s.quantity || 1) + Number(s.material_charge || 0),
    }));
    const grand_total = lines.reduce((sum, l) => sum + l.line_total, 0);
    modernOk(res, { job_id: jobId, services: lines, grand_total });
  } catch (e) { next(e); }
});

router.post('/:id/estimate/send-for-approval',
  validate(idParam, 'params'),
  validate(require('joi').object({
    comments: require('joi').string().max(1000).allow('', null).optional(),
  }).optional()),
  scopedJob,
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Stamp tbl_job — mirrors legacy `JobApproveDetails` second UPDATE.
        await conn.query(
          `UPDATE tbl_job
              SET job_status = 15,
                  approval_sent_on_date_time = NOW(),
                  no_of_req_approval = COALESCE(no_of_req_approval, 0) + 1
            WHERE job_id = ?`,
          [jobId]
        );
        await conn.commit();
      } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }

      // Fire email asynchronously — failure shouldn't roll back the
      // state transition. Reporting contact email lives on tbl_client_contacts.
      sendEstimateEmail(jobId, req.user.user_id).catch(() => {});
      modernOk(res, { sent: true, status: 15 });
    } catch (e) { next(e); }
  }
);

async function sendEstimateEmail(jobId, userId) {
  const [[j]] = await pool.query(
    `SELECT j.job_id, j.job_reference_id, j.client_ref_id, j.reporting_contact_id,
            j.client_spoc_email, j.fk_client_id,
            cl.client_name, cu.customer_name, cu.customer_mob_no,
            u.official_email AS owner_email
       FROM tbl_job j
       LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_user      u ON u.user_id      = j.job_owner
      WHERE j.job_id = ? LIMIT 1`,
    [jobId]
  );
  if (!j) return;
  const [services] = await pool.query(
    `SELECT js.quantity, js.total_charge, js.material_charge,
            CR.crc_ratecard_name AS service_name
       FROM tbl_job_services js
       LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
       LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
      WHERE js.job_id = ? AND js.job_service_status = 1`,
    [jobId]
  );

  const total = services.reduce((s, x) => s + Number(x.total_charge || 0) * Number(x.quantity || 1) + Number(x.material_charge || 0), 0);
  const lineBlock = services
    .map((s) => `  ${s.service_name || '—'} × ${s.quantity}  =  ${(Number(s.total_charge || 0) * Number(s.quantity || 1) + Number(s.material_charge || 0)).toFixed(2)}`)
    .join('\n');

  // Recipient resolution mirrors legacy `confirmApprovejob`:
  // reporting contact's manager_name CSV (legacy stores emails here, not
  // names) + contact_email, owner email. Skip clearly malformed entries
  // so a typo in one CSV field doesn't poison the whole send.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const recipients = new Set();
  const skipped = [];
  const addIfValid = (raw, source) => {
    const v = String(raw || '').trim();
    if (!v) return;
    if (EMAIL_RE.test(v)) recipients.add(v);
    else skipped.push({ value: v, source });
  };
  addIfValid(j.client_spoc_email, 'job.client_spoc_email');
  addIfValid(j.owner_email,       'owner.official_email');
  if (j.reporting_contact_id) {
    const [[c]] = await pool.query(
      'SELECT contact_email, manager_name FROM tbl_client_contacts WHERE id = ?',
      [j.reporting_contact_id]
    );
    if (c) {
      addIfValid(c.contact_email, 'contact.contact_email');
      if (c.manager_name) {
        for (const m of String(c.manager_name).split(',')) {
          addIfValid(m, 'contact.manager_name[]');
        }
      }
    }
  }
  if (recipients.size === 0) {
    require('../../logger').warn(
      `Estimate email skipped — no valid recipients for job ${jobId}` +
      (skipped.length ? ` (rejected ${skipped.length} malformed entries)` : '')
    );
    return;
  }

  await emailServiceForJobs.send({
    to: [...recipients],
    subject: `Client_Estimate Approval_${j.job_id}_${j.customer_name || ''}_${j.customer_mob_no || ''}`,
    text: `Hi ${j.client_name || ''},\n\n`
      + `Please find below the estimate for job ${j.job_reference_id || j.job_id}.\n\n`
      + `Services:\n${lineBlock}\n\n`
      + `Grand total: ${total.toFixed(2)}\n\n`
      + `Kindly approve via the client portal.\n\nRegards,\nEasyFix`,
    category: 'estimate.send-for-approval',
  });
}

// ─── Job Comments sub-resource (legacy tbl_job_comment) ──────────────
const jobComments = require('../../services/job-comment.service');
const Joi = require('joi');
const commentBody = Joi.object({
  comments:       Joi.string().trim().min(1).max(2000).required(),
  comment_on:     Joi.number().integer().valid(1, 2, 3, 4).required(),
  appointment_on: Joi.date().iso().optional(),
  enum_reason_id: Joi.number().integer().positive().optional(),
  efr_id:         Joi.number().integer().positive().optional(),
});

router.get('/:id/comments', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try { modernOk(res, await jobComments.listComments(req.params.id)); }
  catch (e) { next(e); }
});

router.post('/:id/comments',
  validate(idParam, 'params'),
  validate(commentBody),
  scopedJob,
  async (req, res, next) => {
    try {
      const created = await jobComments.addComment(req.params.id, {
        ...req.body,
        commented_by: req.user?.user_id,
      });
      res.status(201);
      modernOk(res, created, 'Comment added');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

// ─── Job Feedback sub-resource (legacy tbl_customer_feedback) ─────────
const jobFeedback = require('../../services/job-feedback.service');
// VERIFIED against tbl_customer_feedback (see services/job-feedback.service.js).
// Legacy columns: easyfixer_rating, easyfix_rating, happy_with_service.
// `happyWithService` is a tinyint (0/1) per legacy convention.
const feedbackBody = Joi.object({
  easyfixerRating:   Joi.number().min(1).max(5).optional(),
  easyfixRating:     Joi.number().min(1).max(5).optional(),
  happyWithService:  Joi.number().integer().valid(0, 1).optional(),
}).min(1);

router.get('/:id/feedback', validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try { modernOk(res, await jobFeedback.getFeedback(req.params.id)); }
  catch (e) { next(e); }
});

router.put('/:id/feedback',
  validate(idParam, 'params'),
  validate(feedbackBody),
  scopedJob,
  async (req, res, next) => {
    try {
      const row = await jobFeedback.upsertFeedback(Number(req.params.id), req.body);
      modernOk(res, row, 'Feedback saved');
    } catch (e) { next(e); }
  }
);

/*
 * ─── Job Image upload (S3 with local fallback) ─────────────────────
 *
 * POST /api/admin/jobs/:id/images   multipart/form-data; field=file
 *   - Uploads the binary to S3 at Job_Images/<jobId>_<seq>.
 *   - seq is computed server-side as (current_image_count + 1) so the
 *     keys line up deterministically with the ops spec.
 *   - INSERTs into tbl_job_image with the FULL S3 key in the `image`
 *     column; this is what distinguishes S3-stored rows from legacy
 *     bare-filename rows on read.
 *   - If S3 is disabled (no S3_BUCKET_NAME), falls back to the local
 *     writeBuffer() path under UPLOAD_JOB_FILES so dev / single-host
 *     deploys keep working.
 *
 * GET  /api/admin/jobs/images/:imageId/file
 *   - 302-redirects to either the S3 presigned URL (if the file
 *     exists in the bucket) or the local /easydoc/upload_jobs/<file>
 *     URL. Read priority: S3 first, then local — matches the ops
 *     migration rule of 2026-05-14.
 *   - Imageid is global (not scoped to a job) because every image row
 *     carries its own job_id which we resolve internally; this keeps
 *     the URL simple for <img src="…"> bindings.
 */
const multerForImages = require('multer');
const { pool: imagePool } = require('../../db');
const { writeBuffer } = require('../../utils/file-storage');
const s3Storage = require('../../utils/s3-storage');
const uploadLogger = require('../../logger');
const imageUpload = multerForImages({
  storage: multerForImages.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

router.post(
  '/:id/images',
  validate(idParam, 'params'),
  scopedJob,
  imageUpload.single('file'),
  async (req, res, next) => {
    const jobId = Number(req.params.id);
    try {
      if (!req.file) {
        uploadLogger.warn({ jobId }, 'job image upload rejected — missing file field');
        return modernError(res, 400, 'missing "file" upload');
      }

      // Compute the next seq from existing rows. Off-by-one safe: if
      // there are 0 existing rows, seq=1. Two concurrent uploads can
      // race here; we accept that risk because (a) it's the ops UI
      // single-uploading per booking, (b) S3 PutObject is idempotent
      // by key (last-write wins), and (c) the seq is just for
      // human-readable keys, not a uniqueness constraint.
      const [[{ existing }]] = await imagePool.query(
        'SELECT COUNT(*) AS existing FROM tbl_job_image WHERE job_id = ?',
        [jobId]
      );
      const seq = Number(existing || 0) + 1;

      // Entry log — captures intent + the bits we'll need to debug any
      // downstream S3/DB failure (jobId, seq, originalname, mimetype,
      // size). originalname is logged here because it never lands in
      // the DB (lives only in S3 object metadata), so this is the
      // primary audit trail tying job_id → user-provided filename.
      uploadLogger.upload({
        jobId, seq,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        bytes: req.file.size,
      }, 'job image upload received');

      let imageValue;
      let usedStorage;

      if (s3Storage.isEnabled()) {
        // Happy path: S3. Store the canonical key in the DB so
        // resolveImageUrl() reads it back as an S3 object.
        //
        // Category convention (per ops 2026-05-15): this endpoint is
        // the Book-New-Call attachment surface — every upload here
        // belongs to the `Booking` lifecycle stage, so we hardcode
        // it. Completion / Reschedule / Cancellation uploads will
        // arrive on their own routes (or take an explicit
        // `?category=` param) when those flows ship; do NOT extend
        // this handler to accept user-supplied category strings
        // without server-side validation against an allowlist —
        // keyFor() also defends with a PascalCase regex.
        //
        // The final S3 key shape is `JobSupportings/Booking_<jobId>_<seq>`
        // — no file extension on the key itself. The file's actual
        // extension/MIME is preserved via Content-Type (set from
        // req.file.mimetype) and the original filename is stashed
        // as object metadata for audit.
        try {
          imageValue = await s3Storage.putJobImage({
            jobId, seq,
            buffer: req.file.buffer,
            contentType: req.file.mimetype,
            originalName: req.file.originalname,
            category: 'Booking',
          });
          usedStorage = 's3';
          uploadLogger.upload({ jobId, seq, key: imageValue }, 'job image stored on S3');
        } catch (e) {
          // S3 failed mid-flight — fall back to local writeBuffer so
          // the booking image isn't lost. The next reader will use
          // the local URL automatically.
          uploadLogger.warn(
            { jobId, seq, err: e },
            'S3 putJobImage failed — falling back to local disk',
          );
          const saved = writeBuffer('job_files', req.file.buffer, req.file.originalname, req.file.mimetype);
          imageValue = saved.filename;
          usedStorage = 'local-fallback';
          uploadLogger.upload({ jobId, seq, filename: imageValue }, 'job image stored on local disk (fallback)');
        }
      } else {
        // S3 not configured — pure local path (dev / small deploys).
        const saved = writeBuffer('job_files', req.file.buffer, req.file.originalname, req.file.mimetype);
        imageValue = saved.filename;
        usedStorage = 'local';
        uploadLogger.upload({ jobId, seq, filename: imageValue }, 'job image stored on local disk (S3 disabled)');
      }

      const [ins] = await imagePool.query(
        `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
         VALUES (?, ?, ?, ?, NOW())`,
        [jobId, imageValue, 'booking', 0]
      );

      uploadLogger.upload(
        { jobId, seq, imageId: ins.insertId, storage: usedStorage, image: imageValue },
        'job image row inserted',
      );

      modernOk(res, {
        image_id: ins.insertId,
        job_id: jobId,
        image: imageValue,
        image_category: 'booking',
        job_stage: 0,
        seq,
        storage: usedStorage,
      }, 'image uploaded');
    } catch (e) {
      if (e?.code === 'LIMIT_FILE_SIZE') {
        uploadLogger.warn({ jobId, bytes: req.file?.size }, 'job image upload rejected — exceeds 10MB');
        return modernError(res, 400, 'file exceeds 10MB');
      }
      uploadLogger.error({ jobId, err: e }, 'job image upload failed');
      next(e);
    }
  }
);

router.get('/images/:imageId/file', async (req, res, next) => {
  try {
    const imageId = Number(req.params.imageId);
    if (!Number.isInteger(imageId) || imageId <= 0) {
      return modernError(res, 400, 'invalid imageId');
    }
    const [[row]] = await imagePool.query(
      'SELECT image_id, job_id, image FROM tbl_job_image WHERE image_id = ? LIMIT 1',
      [imageId]
    );
    if (!row || !row.image) return modernError(res, 404, 'image not found');

    // RBAC: confirm the job is in this user's scope. Reuse the
    // existing per-job scope assertion so out-of-scope ids 404 the
    // same as an unknown imageId would.
    const j = await job.getById(row.job_id);
    if (!j) return modernError(res, 404, 'image not found');
    const guard = assertEntityInScope(req, {
      client_id:   j.fk_client_id,
      city_id:     j.city_id,
      vertical_id: j.vertical_id,
    });
    if (!guard.ok) return modernError(res, 404, 'image not found');

    /*
     * Opt-in lazy migration. When S3_MIGRATE_LEGACY_TO_S3=true and the
     * row still has a bare filename (legacy local-only), upload the
     * local file to S3 at Job_Images/<jobId>_<seq>, UPDATE the row
     * to point at the new key, and (inside migrateLegacyToS3) unlink
     * the local file. The next read of this image will hit S3.
     *
     * `seq` is this row's 1-based ordinal among its job's images
     * ordered by image_id. Counting `image_id <= row.image_id` keeps
     * the seq stable across re-renders even when sibling rows
     * migrate at different times.
     *
     * Migration failure is non-fatal: we fall through and serve the
     * local URL. resolveImageUrl already handles that case. The
     * local-file unlink itself is also best-effort — see
     * utils/s3-storage.js::migrateLegacyToS3 for the cleanup contract.
     */
    if (s3Storage.shouldMigrateLegacy() && !String(row.image).includes('/')) {
      const [[{ seq }]] = await imagePool.query(
        `SELECT COUNT(*) AS seq
           FROM tbl_job_image
          WHERE job_id = ? AND image_id <= ?`,
        [row.job_id, row.image_id]
      );
      const newKey = await s3Storage.migrateLegacyToS3({
        storedValue: row.image,
        jobId: row.job_id,
        seq: Number(seq) || 1,
      });
      if (newKey) {
        await imagePool.query(
          'UPDATE tbl_job_image SET image = ? WHERE image_id = ?',
          [newKey, row.image_id]
        );
        row.image = newKey;
      }
    }

    const url = await s3Storage.resolveImageUrl(row.image);
    if (!url) return modernError(res, 404, 'image url unresolvable');
    return res.redirect(url);
  } catch (e) { next(e); }
});

module.exports = router;
