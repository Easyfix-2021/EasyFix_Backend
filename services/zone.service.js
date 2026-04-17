const { pool } = require('../db');

/*
 * Zone management on top of the existing legacy schema:
 *
 *   tbl_zone_master          — 25 named zones ("Center 1", "North Zone", …)
 *   tbl_zone_city_mapping    — zone → city (many-to-many; one zone covers many
 *                              cities, one city can belong to several zones)
 *   pincode_firefox_city_mapping — pincodes grouped by city (1,014 pincodes,
 *                              keyed by city_name since firefox_city_id isn't
 *                              shared with tbl_city reliably)
 *   tbl_easyfixer.efr_zone_city_id → tbl_zone_city_mapping.city_zone_id
 *
 * So the effective relationship chain is:
 *   zone → [city_zone rows] → { cities, pincodes-by-city-name, easyfixers }
 *
 * NO new tables created — per the repo's "never alter schema" rule — the
 * feature is pure app-layer glue over what's already there.
 */

// ─── Zones list with denormalised counts ─────────────────────────────
/*
 * Single query with GROUP BY + sub-counts. Saves N+1 (previously-naïve
 * "for each zone, count cities/efrs/pincodes" would be 3×25 = 75 queries).
 */
async function listZones() {
  const [rows] = await pool.query(`
    SELECT
      z.zone_id,
      z.zone_name,
      z.zone_status,
      z.created_date,
      (SELECT COUNT(DISTINCT zcm.city_id)
         FROM tbl_zone_city_mapping zcm
        WHERE zcm.zone_id = z.zone_id)            AS city_count,
      (SELECT COUNT(*)
         FROM tbl_easyfixer e
         JOIN tbl_zone_city_mapping zcm
           ON zcm.city_zone_id = e.efr_zone_city_id
        WHERE zcm.zone_id = z.zone_id
          AND e.efr_status = 1)                    AS easyfixer_count,
      (SELECT COUNT(DISTINCT p.pincode)
         FROM tbl_zone_city_mapping zcm
         JOIN tbl_city c            ON c.city_id = zcm.city_id
         JOIN pincode_firefox_city_mapping p
           ON p.city_name = c.city_name
        WHERE zcm.zone_id = z.zone_id)             AS pincode_count
      FROM tbl_zone_master z
     ORDER BY z.zone_id ASC
  `);
  return rows;
}

// ─── Zone detail: cities + pincodes + easyfixer summary ──────────────
async function getZoneDetail(zoneId) {
  const [[zone]] = await pool.query(
    'SELECT zone_id, zone_name, zone_status, created_date FROM tbl_zone_master WHERE zone_id = ? LIMIT 1',
    [zoneId]
  );
  if (!zone) return null;

  // Cities belonging to this zone (through zone_city_mapping).
  const [cities] = await pool.query(`
    SELECT DISTINCT c.city_id, c.city_name
      FROM tbl_zone_city_mapping zcm
      JOIN tbl_city c ON c.city_id = zcm.city_id
     WHERE zcm.zone_id = ?
     ORDER BY c.city_name ASC
  `, [zoneId]);

  // Pincodes in those cities (joined by city_name since the two city tables
  // aren't FK-linked in this schema — it's stringy but reliable on the prod
  // dataset I sampled).
  const [pincodes] = await pool.query(`
    SELECT DISTINCT p.pincode, p.city_name
      FROM tbl_zone_city_mapping zcm
      JOIN tbl_city c ON c.city_id = zcm.city_id
      JOIN pincode_firefox_city_mapping p ON p.city_name = c.city_name
     WHERE zcm.zone_id = ?
     ORDER BY p.city_name ASC, p.pincode ASC
  `, [zoneId]);

  return { ...zone, cities, pincodes };
}

// ─── Easyfixers in a zone (with search) ──────────────────────────────
/*
 * Search happens across name, mobile, email. Results are capped for UI safety
 * — a zone can easily contain 1000+ easyfixers and the dropdown/table doesn't
 * need all of them at once. Paginate if a zone ever exceeds the limit.
 */
async function searchEasyfixersInZone(zoneId, { q, limit = 200, activeOnly = true } = {}) {
  const clauses = ['zcm.zone_id = ?'];
  const params = [zoneId];
  if (activeOnly) clauses.push('e.efr_status = 1');
  if (q) {
    clauses.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_email LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  params.push(Number(limit));
  const [rows] = await pool.query(`
    SELECT
      e.efr_id, e.efr_name, e.efr_no, e.efr_email,
      e.efr_cityId, e.is_technician_verified, e.efr_profile_perc,
      e.efr_status,
      c.city_name,
      zcm.city_zone_id
      FROM tbl_easyfixer e
      JOIN tbl_zone_city_mapping zcm ON zcm.city_zone_id = e.efr_zone_city_id
      LEFT JOIN tbl_city c ON c.city_id = zcm.city_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.efr_name ASC
     LIMIT ?
  `, params);
  return rows;
}

/*
 * Reverse lookup: which easyfixers serve a given pincode? The answer is "all
 * easyfixers in any zone whose cities contain that pincode." One of the two
 * primary user asks on the Zones page — "search for easyfixers in required
 * zone" implies also "which easyfixers does pincode X have access to."
 */
async function searchEasyfixersByPincode(pincode, { limit = 200 } = {}) {
  const [rows] = await pool.query(`
    SELECT DISTINCT
      e.efr_id, e.efr_name, e.efr_no, e.efr_email,
      e.is_technician_verified, e.efr_profile_perc,
      e.efr_status,
      c.city_name,
      z.zone_id, z.zone_name
      FROM pincode_firefox_city_mapping p
      JOIN tbl_city c              ON c.city_name = p.city_name
      JOIN tbl_zone_city_mapping zcm ON zcm.city_id = c.city_id
      JOIN tbl_zone_master z        ON z.zone_id = zcm.zone_id
      JOIN tbl_easyfixer e          ON e.efr_zone_city_id = zcm.city_zone_id
     WHERE p.pincode = ?
       AND e.efr_status = 1
     ORDER BY e.efr_name ASC
     LIMIT ?
  `, [pincode, Number(limit)]);
  return rows;
}

module.exports = {
  listZones,
  getZoneDetail,
  searchEasyfixersInZone,
  searchEasyfixersByPincode,
};
