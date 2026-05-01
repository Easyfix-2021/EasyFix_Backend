const { pool } = require('../db');

/*
 * Manage Zones — spec-aligned model (2026-05-01).
 *
 * Data model:
 *   tbl_zone_master(zone_id, zone_name, city_id, zone_status, ...)
 *     — Each zone belongs to ONE city (city_id is the spec's binding).
 *
 *   tbl_pincode(pincode_id, pincode, city_id, zone_id, ...)
 *     — Each pincode belongs to AT MOST one zone (zone_id NULL = unzoned).
 *     — Schema enforces "one pincode → one zone" by virtue of being one
 *       column; no junction table exists.
 *
 *   tbl_zone_city_mapping (legacy)
 *     — Kept as a transitional shadow: one row per zone (zone_id + city_id),
 *       mirroring tbl_zone_master.city_id. Required because
 *       tbl_easyfixer.efr_zone_city_id still references its city_zone_id;
 *       deleting it would break legacy auto-assign + integration paths.
 *       New code does NOT join through it; it's maintained on writes only
 *       so legacy reads keep working.
 *
 *   tbl_easyfixer.efr_zone_city_id → tbl_zone_city_mapping.city_zone_id
 *     — Untouched. Easyfixers still bind to a (zone, city) pair, which under
 *       the new 1:1 model is simply the zone.
 *
 * "No. of technicians" = active+verified easyfixers in this zone.
 * "No. of pincodes"    = COUNT of tbl_pincode rows with zone_id = z.zone_id.
 */

// ─── List ────────────────────────────────────────────────────────────
async function listZones() {
  const [rows] = await pool.query(`
    SELECT
      z.zone_id,
      z.zone_name,
      z.zone_status,
      z.created_date,
      z.city_id,
      c.city_name,
      (SELECT COUNT(*) FROM tbl_pincode p
        WHERE p.zone_id = z.zone_id AND p.pincode_status = 1) AS pincode_count,
      (SELECT COUNT(*) FROM tbl_easyfixer e
         JOIN tbl_zone_city_mapping zcm ON zcm.city_zone_id = e.efr_zone_city_id
        WHERE zcm.zone_id = z.zone_id AND e.efr_status = 1)   AS technician_count
      FROM tbl_zone_master z
      LEFT JOIN tbl_city   c ON c.city_id = z.city_id
     ORDER BY c.city_name ASC, z.zone_name ASC
  `);
  return rows;
}

// ─── Detail (zone + assigned pincodes) ───────────────────────────────
async function getZoneDetail(zoneId) {
  const [[zone]] = await pool.query(
    `SELECT z.zone_id, z.zone_name, z.zone_status, z.created_date,
            z.city_id, c.city_name
       FROM tbl_zone_master z
       LEFT JOIN tbl_city   c ON c.city_id = z.city_id
      WHERE z.zone_id = ?
      LIMIT 1`,
    [zoneId]
  );
  if (!zone) return null;

  // Pincodes assigned to this zone (canonical: tbl_pincode.zone_id).
  const [pincodes] = await pool.query(
    `SELECT pincode_id, pincode, location, district, pincode_status
       FROM tbl_pincode
      WHERE zone_id = ?
      ORDER BY pincode ASC`,
    [zoneId]
  );

  // Technician count + pincode count (mirrors the list query) — handy for
  // detail-page summary cards without a second round-trip from the UI.
  const [[counts]] = await pool.query(
    `SELECT
        (SELECT COUNT(*) FROM tbl_pincode p
          WHERE p.zone_id = ? AND p.pincode_status = 1) AS pincode_count,
        (SELECT COUNT(*) FROM tbl_easyfixer e
           JOIN tbl_zone_city_mapping zcm ON zcm.city_zone_id = e.efr_zone_city_id
          WHERE zcm.zone_id = ? AND e.efr_status = 1)   AS technician_count`,
    [zoneId, zoneId]
  );

  return { ...zone, pincodes, ...counts };
}

// ─── Pincodes available for assigning to this zone ───────────────────
/*
 * Eligible = active pincodes in the zone's city that are either currently
 * unzoned (zone_id IS NULL) or already assigned to THIS zone. Pincodes
 * already on a different zone are deliberately excluded — assigning one
 * here would silently steal it from the other zone, breaking
 * "one pincode → one zone." If you need to move a pincode, deassign from
 * its current zone first (visible on the other zone's editor).
 */
async function listAssignablePincodes(zoneId) {
  const [[zone]] = await pool.query(
    'SELECT city_id FROM tbl_zone_master WHERE zone_id = ? LIMIT 1', [zoneId]
  );
  if (!zone || !zone.city_id) return [];
  const [rows] = await pool.query(
    `SELECT pincode_id, pincode, location, district, zone_id
       FROM tbl_pincode
      WHERE city_id = ?
        AND pincode_status = 1
        AND (zone_id IS NULL OR zone_id = ?)
      ORDER BY pincode ASC`,
    [zone.city_id, zoneId]
  );
  return rows;
}

// ─── Easyfixers in a zone (with search) ──────────────────────────────
async function searchEasyfixersInZone(zoneId, { q, limit = 200, activeOnly = true } = {}) {
  const clauses = ['zcm.zone_id = ?'];
  const params  = [zoneId];
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
 * Reverse lookup — which easyfixers serve a given pincode? Under the new
 * model: pincode → zone → easyfixers (via the legacy junction). One JOIN
 * shorter than the firefox version because pincode has zone_id directly.
 */
async function searchEasyfixersByPincode(pincode, { limit = 200 } = {}) {
  const [rows] = await pool.query(`
    SELECT DISTINCT
      e.efr_id, e.efr_name, e.efr_no, e.efr_email,
      e.is_technician_verified, e.efr_profile_perc, e.efr_status,
      c.city_name,
      z.zone_id, z.zone_name
      FROM tbl_pincode p
      JOIN tbl_zone_master z         ON z.zone_id = p.zone_id
      JOIN tbl_zone_city_mapping zcm ON zcm.zone_id = z.zone_id
      JOIN tbl_easyfixer e           ON e.efr_zone_city_id = zcm.city_zone_id
      LEFT JOIN tbl_city c           ON c.city_id = z.city_id
     WHERE p.pincode = ?
       AND e.efr_status = 1
     ORDER BY e.efr_name ASC
     LIMIT ?
  `, [String(pincode), Number(limit)]);
  return rows;
}

// ─── Create / Update zone ────────────────────────────────────────────
function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

async function assertCityExists(conn, cityId) {
  const [[r]] = await conn.query('SELECT city_id FROM tbl_city WHERE city_id = ? LIMIT 1', [cityId]);
  if (!r) throw mkErr(400, `Unknown city_id ${cityId}`);
}

/*
 * Zone names are unique WITHIN a city (not globally). "South Delhi" inside
 * Delhi is fine even if "South" exists in another city. Compare against
 * (city_id, lower(zone_name)).
 */
async function createZone({ zone_name, city_id }) {
  const trimmed = String(zone_name || '').trim();
  if (!trimmed) throw mkErr(400, 'zone_name required');
  if (!city_id) throw mkErr(400, 'city_id required');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await assertCityExists(conn, city_id);

    const [[dup]] = await conn.query(
      `SELECT zone_id FROM tbl_zone_master
        WHERE city_id = ? AND LOWER(zone_name) = LOWER(?) LIMIT 1`,
      [city_id, trimmed]
    );
    if (dup) throw mkErr(409, `Zone "${trimmed}" already exists in this city`);

    const [r] = await conn.query(
      `INSERT INTO tbl_zone_master (zone_name, city_id, zone_status, created_date)
       VALUES (?, ?, 1, NOW())`,
      [trimmed, Number(city_id)]
    );
    const zoneId = r.insertId;

    // Maintain the legacy tbl_zone_city_mapping shadow row so any code
    // that still binds via efr_zone_city_id continues to resolve.
    await conn.query(
      `INSERT INTO tbl_zone_city_mapping (zone_id, city_id) VALUES (?, ?)`,
      [zoneId, Number(city_id)]
    );

    await conn.commit();
    return getZoneDetail(zoneId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * Updateable fields: zone_name, zone_status. city_id is NOT updateable —
 * moving a zone to a different city would invalidate every assigned
 * pincode (different city_id) and dangle technicians. To "move" a zone,
 * delete and re-create.
 */
async function updateZone(zoneId, { zone_name, zone_status }) {
  const sets = [];
  const vals = [];
  if (zone_name !== undefined) {
    const trimmed = String(zone_name).trim();
    if (!trimmed) throw mkErr(400, 'zone_name cannot be blank');

    const [[me]] = await pool.query('SELECT city_id FROM tbl_zone_master WHERE zone_id = ? LIMIT 1', [zoneId]);
    if (!me) throw mkErr(404, 'Zone not found');

    const [[dup]] = await pool.query(
      `SELECT zone_id FROM tbl_zone_master
        WHERE city_id = ? AND LOWER(zone_name) = LOWER(?) AND zone_id <> ? LIMIT 1`,
      [me.city_id, trimmed, zoneId]
    );
    if (dup) throw mkErr(409, `Another zone with name "${trimmed}" exists in this city`);

    sets.push('zone_name = ?'); vals.push(trimmed);
  }
  if (zone_status !== undefined) { sets.push('zone_status = ?'); vals.push(zone_status ? 1 : 0); }
  if (sets.length === 0) return getZoneDetail(zoneId);

  vals.push(zoneId);
  await pool.query(`UPDATE tbl_zone_master SET ${sets.join(', ')} WHERE zone_id = ?`, vals);
  return getZoneDetail(zoneId);
}

// ─── Replace the zone's pincode set ──────────────────────────────────
/*
 * Wipe-and-reinsert UX: the editor sends the WHOLE pincode list it wants
 * the zone to own. We unassign anything previously on this zone that's
 * not in the new list, then assign the new list. We refuse to steal
 * pincodes that are currently assigned to a DIFFERENT zone — those rows
 * are skipped and reported as `rejected` so the UI can show what happened.
 *
 * Cross-city safety: only pincodes belonging to this zone's city are
 * accepted. Anything else is rejected.
 */
async function setPincodeMapping(zoneId, pincodeIds, { userId = null } = {}) {
  const ids = Array.from(new Set((pincodeIds || []).map(Number).filter(Number.isFinite)));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[zone]] = await conn.query(
      'SELECT zone_id, city_id FROM tbl_zone_master WHERE zone_id = ? LIMIT 1', [zoneId]
    );
    if (!zone) throw mkErr(404, 'Zone not found');

    let rejected = [];
    if (ids.length) {
      // Validate every requested id: must exist, must belong to this zone's
      // city, must not be already on a different zone.
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await conn.query(
        `SELECT pincode_id, pincode, city_id, zone_id
           FROM tbl_pincode WHERE pincode_id IN (${placeholders})`,
        ids
      );
      const byId = new Map(rows.map((r) => [Number(r.pincode_id), r]));
      const acceptable = [];
      for (const id of ids) {
        const r = byId.get(id);
        if (!r) {
          rejected.push({ pincode_id: id, reason: 'Pincode not found' });
        } else if (Number(r.city_id) !== Number(zone.city_id)) {
          rejected.push({ pincode_id: id, pincode: r.pincode, reason: 'Different city than this zone' });
        } else if (r.zone_id != null && Number(r.zone_id) !== Number(zoneId)) {
          rejected.push({ pincode_id: id, pincode: r.pincode, reason: `Already in another zone (id ${r.zone_id})` });
        } else {
          acceptable.push(id);
        }
      }

      // Unassign anything previously on this zone that's not in the new set.
      const acceptableSet = new Set(acceptable);
      const [currentRows] = await conn.query(
        'SELECT pincode_id FROM tbl_pincode WHERE zone_id = ?', [zoneId]
      );
      const toClear = currentRows
        .map((r) => Number(r.pincode_id))
        .filter((id) => !acceptableSet.has(id));
      if (toClear.length) {
        const ph = toClear.map(() => '?').join(',');
        await conn.query(
          `UPDATE tbl_pincode SET zone_id = NULL, updated_by = ?
            WHERE pincode_id IN (${ph})`,
          [userId, ...toClear]
        );
      }

      // Assign acceptable ids to this zone.
      if (acceptable.length) {
        const ph = acceptable.map(() => '?').join(',');
        await conn.query(
          `UPDATE tbl_pincode SET zone_id = ?, updated_by = ?
            WHERE pincode_id IN (${ph})`,
          [zoneId, userId, ...acceptable]
        );
      }
    } else {
      // Empty list = unassign everything currently on this zone.
      await conn.query(
        'UPDATE tbl_pincode SET zone_id = NULL, updated_by = ? WHERE zone_id = ?',
        [userId, zoneId]
      );
    }

    await conn.commit();
    const detail = await getZoneDetail(zoneId);
    return { ...detail, rejected };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  listZones,
  getZoneDetail,
  listAssignablePincodes,
  searchEasyfixersInZone,
  searchEasyfixersByPincode,
  createZone,
  updateZone,
  setPincodeMapping,
};
