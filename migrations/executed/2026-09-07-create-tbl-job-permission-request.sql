-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-07 — Site-access permission requests raised by a technician
--              against a job, fulfilled by the client.
--
-- WHAT: on site, a technician sometimes cannot get in — a mall gate pass, a
-- society NOC, a building access letter. He raises a REQUEST against the job;
-- the client sees it on the Client Dashboard and uploads the document; the
-- technician then sees it and carries on. One row per request.
--
-- SHARED-DB RULE — THIS IS THE DOCUMENTED EXCEPTION
--   CLAUDE.md forbids altering the shared `easyfix_core` schema. Its stated
--   carve-out is an EASYFIX-OWNED NEW TABLE THAT NO LEGACY SERVICE REFERENCES,
--   already used by tbl_pincode (2026-05-01), tbl_user_allowed_stages
--   (2026-07-29), tbl_user_personal_details (2026-08-03),
--   tbl_easyfixer_sensitive_change_log (2026-08-17) and
--   tbl_sensitive_reveal_log (2026-09-01). This table is written and read by
--   services/job-permission-request.service.js in this backend and by nothing
--   legacy. NOTHING existing is altered by this file.
--
-- ══════════════════════════════════════════════════════════════════════
-- THE IDEMPOTENCY RULE, AND WHY IT IS A DB CONSTRAINT AND NOT A `SELECT` FIRST
-- ══════════════════════════════════════════════════════════════════════
-- The rule: AT MOST ONE OPEN REQUEST PER (job_id, kind). A technician who taps
-- "Request" twice gets the SAME request back, not a second one — and the client
-- never sees two identical cards of which fulfilling one leaves the other open
-- forever.
--
-- The service does read before it writes, which handles the ordinary
-- double-tap. That read is not the guarantee: two taps a few milliseconds apart
-- (or an offline outbox flushing a queued write while the user taps again) both
-- see "no open request" and both insert. A guarantee that holds only when the
-- two requests are far enough apart is the guarantee you do not have precisely
-- when the user is on a bad connection, which is when they tap twice.
--
-- So the constraint lives in the index. `open_dedupe_key` is a VIRTUAL
-- generated column carrying `job_id:lower(kind)` WHILE THE ROW IS OPEN and NULL
-- once it is resolved. MySQL permits unlimited NULLs in a UNIQUE index, so:
--   - two open rows for the same job+kind  → both keys equal → rejected
--   - a resolved row and a new open one    → resolved key is NULL → allowed
-- which is exactly "one OPEN request per job+kind, any number of historical
-- ones". The service catches ER_DUP_ENTRY, re-reads, and returns the winner, so
-- the loser of the race gets the same answer as the winner rather than a 500.
--
-- The column is VIRTUAL, not STORED: it is never selected by any query (only
-- the index reads it), so materialising it would cost row width for nothing.
-- Generated columns are MySQL 5.7+ / MariaDB 10.2+; this schema already runs
-- WITH RECURSIVE (services/client-auth hierarchy), which needs MySQL 8.0 /
-- MariaDB 10.2.2, so the floor is already above what this needs.
--
-- `kind` is lower-cased INSIDE the key rather than at the column, because the
-- label the technician chose is what both frontends display — "Mall Gate Pass"
-- must survive as typed while still colliding with "mall gate pass".
--
-- ── Column notes ────────────────────────────────────────────────────────
-- job_id              tbl_job.job_id the request is about. NOT NULL — a request
--                     with no job is a request about nothing. No FK constraint
--                     (this schema does not use them, and a tbl_job write must
--                     never be blockable by this table).
-- requested_by_efr_id tbl_easyfixer.efr_id of the technician who raised it. The
--                     route only lets a technician raise a request on a job
--                     assigned to him, so this is also the assignee at the time
--                     of raising — stored rather than re-derived, because
--                     tbl_job.fk_easyfixter_id changes on reassignment and the
--                     question "who asked for this" must not change with it.
-- kind                What is being asked for, free text as the app sent it —
--                     'Mall Gate Pass', 'Society NOC', 'Building Access
--                     Letter'. VARCHAR, not ENUM, deliberately: a new kind must
--                     not require an ALTER on a table the shared-DB rule says
--                     we should stop touching, and the app owns the picker.
-- note                Optional free text from the technician ("guard wants it
--                     addressed to Tower B"). NULL when he added none.
-- status              'requested' | 'fulfilled' | 'declined'. VARCHAR for the
--                     same reason as `kind`. The three values are the wire
--                     contract both frontends switch on — see the service.
-- document_image_id   tbl_job_image.image_id of the uploaded document. The
--                     document is an ordinary tbl_job_image row with
--                     image_category = 'permission', stored through the shared
--                     services/job-image.service.js — the same convention the
--                     Billing & Charges Job Sheet / Purchase Order documents
--                     use (routes/admin/job-documents.js), so it inherits the
--                     S3 key shape (no extension, MIME on Content-Type), the
--                     local-disk fallback and the presign path for free. NULL
--                     until fulfilled, and NULL forever on a declined row.
-- fulfilled_by_contact_id
--                     tbl_client_contacts.id of the SPOC who fulfilled OR
--                     declined it. NULL while open.
-- decline_reason      Why the client said no. NULL unless status='declined'.
-- requested_on        DATETIME written by the app as new Date(); the pool's
--                     +05:30 session timezone (db.js) stores the IST wall clock
--                     verbatim. NO DEFAULT CURRENT_TIMESTAMP — the container
--                     clock is UTC, so a DB-side default would silently mix two
--                     timezones into one column and nothing would report it
--                     (same reasoning as executed/2026-08-03-create-tbl-user-
--                     personal-details.sql and 2026-09-01-create-tbl-sensitive-
--                     reveal-log.sql).
-- resolved_on         When it stopped being open — set on fulfil AND on
--                     decline. Named for what it is; the wire contract exposes
--                     it as `fulfilledAt` because that contract has one
--                     resolution timestamp and no separate declinedAt. NULL
--                     while open. Same new Date() / IST rule as requested_on.
--
-- INDEXES
--   idx_jpr_job (job_id) — serves BOTH list endpoints, which are the only
--                          list queries that exist:
--                            GET /api/mobile/jobs/:jobId/permission-requests
--                            GET /api/client/jobs/:jobId/permission-requests
--                          both `WHERE job_id = ? ORDER BY id DESC`. An InnoDB
--                          secondary key already carries the PK as its trailing
--                          column, so (job_id) IS (job_id, id) physically and
--                          the ORDER BY is satisfied by the index — declaring
--                          (job_id, id) would add nothing but bytes. It also
--                          serves the service's pre-insert dedupe read.
--   uq_jpr_open (open_dedupe_key) — the idempotency rule above. UNIQUE, and it
--                          is the constraint, not an access path.
--   The two single-row lookups (fulfil / decline, `WHERE id = ?`) ride the PK.
--
-- HOW TO APPLY
--   Run each statement in order. Plain CREATE — no prepared statements, no
--   @-variables, no PREPARE/EXECUTE, nothing MariaDB-specific. Works identically
--   in MySQL CLI, DataGrip, DBeaver and Workbench.
--
-- IDEMPOTENCY
--   Fully re-runnable: the CREATE is IF NOT EXISTS. No permission seeds here.
--   The mobile side is authenticated as the assigned technician and gated by
--   the existing requireTechJobMutationCapability layer; the client side reuses
--   the existing loadJobInScope resolver and adds no new client access surface
--   (see the service header for why).
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — does this host already have the table? ──────
-- Zero rows = a fresh apply. One row = a re-run, and the CREATE below is a
-- no-op via IF NOT EXISTS.
SELECT table_name, engine, table_rows
  FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_job_permission_request';

CREATE TABLE IF NOT EXISTS tbl_job_permission_request (
  id                      INT NOT NULL AUTO_INCREMENT,
  job_id                  INT NOT NULL,
  requested_by_efr_id     INT NOT NULL,
  kind                    VARCHAR(120) NOT NULL,
  note                    VARCHAR(500) NULL DEFAULT NULL,
  status                  VARCHAR(16) NOT NULL DEFAULT 'requested',
  document_image_id       INT NULL DEFAULT NULL,
  fulfilled_by_contact_id INT NULL DEFAULT NULL,
  decline_reason          VARCHAR(500) NULL DEFAULT NULL,
  requested_on            DATETIME NOT NULL,
  resolved_on             DATETIME NULL DEFAULT NULL,
  open_dedupe_key         VARCHAR(160) AS (IF(status = 'requested', CONCAT(job_id, ':', LOWER(kind)), NULL)) VIRTUAL,
  PRIMARY KEY (id),
  KEY idx_jpr_job (job_id),
  UNIQUE KEY uq_jpr_open (open_dedupe_key)
) ENGINE=InnoDB;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Expect the eleven declared columns plus the generated open_dedupe_key, then
-- both secondary indexes with uq_jpr_open reported as non_unique = 0.
SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, extra
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_job_permission_request'
 ORDER BY ordinal_position;

SELECT index_name, seq_in_index, column_name, non_unique
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_job_permission_request'
 ORDER BY index_name, seq_in_index;

-- ── Hand verification once the feature is live (read-only) ────────────
--
-- 1. THE IDEMPOTENCY RULE ITSELF. This must return ZERO rows, always. A row
--    here means two open requests for one job+kind, i.e. the unique index is
--    missing or was created without the generated column:
-- SELECT job_id, LOWER(kind) AS k, COUNT(*) AS open_dupes FROM tbl_job_permission_request WHERE status = 'requested' GROUP BY job_id, LOWER(kind) HAVING COUNT(*) > 1;
--
-- 2. The open queue, oldest first — what the client has not answered yet:
-- SELECT r.id, r.job_id, r.kind, r.requested_on, e.efr_name AS requested_by, c.client_name FROM tbl_job_permission_request r LEFT JOIN tbl_easyfixer e ON e.efr_id = r.requested_by_efr_id LEFT JOIN tbl_job j ON j.job_id = r.job_id LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id WHERE r.status = 'requested' ORDER BY r.requested_on ASC;
--
-- 3. Turnaround, per client — how long a technician waits at a gate:
-- SELECT c.client_name, COUNT(*) AS resolved, ROUND(AVG(TIMESTAMPDIFF(MINUTE, r.requested_on, r.resolved_on))) AS avg_minutes FROM tbl_job_permission_request r LEFT JOIN tbl_job j ON j.job_id = r.job_id LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id WHERE r.resolved_on IS NOT NULL GROUP BY c.client_name ORDER BY avg_minutes DESC;
--
-- 4. Every fulfilled row must point at a real document; every declined row must
--    not. Both counts should be zero:
-- SELECT SUM(status = 'fulfilled' AND document_image_id IS NULL) AS fulfilled_without_doc, SUM(status = 'declined' AND document_image_id IS NOT NULL) AS declined_with_doc FROM tbl_job_permission_request;
