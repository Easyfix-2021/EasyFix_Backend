-- Reason row for the AUTOMATIC unreachable marker (3 days of failed calls).
--
-- WHY A ROW AND NOT A STRING. The auto-marker has to be distinguishable from
-- the one an operator writes with the Unreachable button, for two reasons: the
-- sweep must not re-mark a job it already marked, and ops must be able to tell
-- "we recorded this" from "the system inferred it". A sentinel in the comment
-- TEXT would do neither reliably — text is edited, translated and truncated.
-- enum_reason_id is a real FK to this row and survives all of that. Same
-- decision, same reasoning, as 2026-09-04-seed-client-request-reasons.sql.
--
-- action_type 25 = UnReachable. user_type 1 = EasyFix (we inferred it; the
-- customer and the client had no part in it).
--
-- is_new = 0 DELIBERATELY. GET /admin/jobs/action-reasons shows the rows at
-- MAX(is_new) per (action_type, user_type); leaving this at 0 keeps it OUT of
-- the operator's dropdown. It describes something the system did, so offering
-- it as a manual choice would let an operator claim an automatic finding.
--
-- is_new is supplied explicitly because it is NOT NULL with no default on this
-- table — the omission is what made the 2026-09-04 seed fail on its first run.
-- `npm run check:migrations` now enforces that; this file passes it.
--
-- Idempotent by construction: re-running inserts nothing.

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status, is_new)
SELECT 25, 'No contact after repeated call attempts', 1, 1, 0
 WHERE NOT EXISTS (
   SELECT 1 FROM action_taken_reason
    WHERE action_type = 25 AND user_type = 1
      AND action_desc = 'No contact after repeated call attempts'
 );
