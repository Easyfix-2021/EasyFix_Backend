/*
 * tbl_city.city_status — the sentinel values, in one place.
 *
 * The column is `tinyint NULL DEFAULT 1` on a shared legacy table, so the state
 * is carried by a sentinel rather than a new column. Same precedent as
 * services/entity-deletion.service.js's DELETED_STATUS = 3.
 *
 *   0 INACTIVE — an operator deactivated it, or a REJECTED city after its rows
 *                were merged into the replacement.
 *   1 ACTIVE   — normal. The only value a selection surface may offer.
 *   2 PENDING  — created automatically by a pincode add and awaiting Manage
 *                Cities approval. Exists, can be attached to, is NOT selectable.
 *
 * NULL is treated as ACTIVE by the queries that predate this file — legacy rows
 * carry it and must keep working. Do not "clean that up" without counting the
 * rows first.
 *
 * ─── WHICH READS SHOULD FILTER ON THIS ───────────────────────────────────
 *
 * ~160 places read tbl_city and MOST DO NOT FILTER — correctly. They JOIN to
 * resolve the NAME of a city a row already points at, and a saved job must keep
 * displaying its city after that city is deactivated. Adding a status filter to
 * a name-resolution JOIN is a bug, not a hardening.
 *
 * Filter only on SELECTION surfaces:
 *   - a list of cities offered to a human to choose from, or
 *   - a resolution that decides the city of a NEW record.
 * Those are the two places where an unapproved city causes harm.
 */
const CITY_STATUS = Object.freeze({
  INACTIVE: 0,
  ACTIVE: 1,
  PENDING: 2,
});

/**
 * SQL fragment for "this city may be offered for selection".
 *
 * Written as an explicit predicate rather than `<> 0` so that a FUTURE sentinel
 * (say 3 = merged) is excluded by default instead of silently becoming
 * selectable — the fail-closed direction. NULL is included because legacy rows
 * carry it and are live.
 *
 * @param {string} alias table alias, e.g. 'c' for `tbl_city c`
 */
function selectableCitySql(alias = 'c') {
  return `(${alias}.city_status = ${CITY_STATUS.ACTIVE} OR ${alias}.city_status IS NULL)`;
}

module.exports = { CITY_STATUS, selectableCitySql };
