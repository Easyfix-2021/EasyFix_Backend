const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');

/*
 * Bulk job upload from parsed Excel rows.
 *
 * Strategy:
 *   1. Pre-fetch name→id maps once per upload (clients, service types, cities) —
 *      avoids one query per row × 500-row upload.
 *   2. For each row: resolve name lookups, validate, attempt create. Each create
 *      runs in its own transaction (inside job.service.create). Row failures do
 *      NOT roll back successful rows — we return per-row results so users know
 *      which rows to fix and re-upload.
 *   3. `dryRun: true` validates without inserting. Useful for preview.
 */

async function buildLookupMaps() {
  const [[cities], [clients], [serviceTypes]] = await Promise.all([
    pool.query('SELECT city_id, LOWER(city_name) AS name FROM tbl_city WHERE city_status = 1'),
    pool.query('SELECT client_id, LOWER(client_name) AS name FROM tbl_client WHERE client_status = 1'),
    pool.query('SELECT service_type_id, LOWER(service_type_name) AS name FROM tbl_service_type WHERE service_type_status = 1'),
  ]);
  return {
    city:        new Map(cities.map((r) => [r.name, r.city_id])),
    client:      new Map(clients.map((r) => [r.name, r.client_id])),
    serviceType: new Map(serviceTypes.map((r) => [r.name, r.service_type_id])),
  };
}

function resolveNameOrId(raw, map) {
  if (raw == null || raw === '') return null;
  // If it's already a numeric ID, use as-is
  if (/^\d+$/.test(String(raw).trim())) return Number(raw);
  const id = map.get(String(raw).trim().toLowerCase());
  return id ?? null;
}

function validateParsed(parsed, resolved) {
  const errors = [];
  if (!parsed.customer?.customer_name) errors.push('customer_name is required');
  if (!resolved.clientId) errors.push(`unrecognised client "${parsed.client}"`);
  if (!parsed.requested_date_time) errors.push('requested_date_time is required/invalid');
  if (!parsed.address?.address) errors.push('address is required');
  if (!resolved.cityId) errors.push(`unrecognised city "${parsed.address.city}"`);
  if (!parsed.address?.pin_code || !/^\d{6}$/.test(parsed.address.pin_code)) {
    errors.push('pin_code must be 6 digits');
  }
  return errors;
}

async function bulkUpload({ rows, skipCount, totalRows }, actor, { dryRun = false } = {}) {
  const maps = await buildLookupMaps();

  const results = [];
  let createdCount = 0;
  let failedCount = skipCount;

  for (const { rowNumber, raw, parsed, skipReason } of rows) {
    if (skipReason) {
      results.push({ rowNumber, status: 'skipped', reason: skipReason });
      continue;
    }

    const resolved = {
      clientId:      resolveNameOrId(parsed.client, maps.client),
      cityId:        resolveNameOrId(parsed.address.city, maps.city),
      serviceTypeId: resolveNameOrId(parsed.service_type, maps.serviceType),
    };

    const errors = validateParsed(parsed, resolved);
    if (errors.length) {
      failedCount++;
      results.push({ rowNumber, status: 'failed', errors, raw });
      continue;
    }

    if (dryRun) {
      results.push({ rowNumber, status: 'valid', resolved });
      continue;
    }

    // Build the create payload
    const payload = {
      fk_client_id: resolved.clientId,
      fk_service_type_id: resolved.serviceTypeId || undefined,
      service_type_ids: resolved.serviceTypeId ? String(resolved.serviceTypeId) : undefined,
      client_ref_id: parsed.client_ref_id,
      job_desc: parsed.job_desc,
      job_type: parsed.job_type,
      source_type: 'excel',
      requested_date_time: parsed.requested_date_time,
      time_slot: parsed.time_slot,
      helper_req: parsed.helper_req,
      job_owner: parsed.job_owner || undefined,
      customer: parsed.customer,
      address: {
        address: parsed.address.address,
        city_id: resolved.cityId,
        pin_code: parsed.address.pin_code,
        gps_location: parsed.address.gps_location,
      },
    };

    try {
      const created = await jobService.create(payload, actor);
      createdCount++;
      results.push({ rowNumber, status: 'created', jobId: created.job_id });
    } catch (e) {
      failedCount++;
      logger.warn({ rowNumber, err: e.message }, 'bulk upload row failed');
      results.push({ rowNumber, status: 'failed', errors: [e.message], raw });
    }
  }

  return {
    summary: {
      totalRows, createdCount, failedCount, skipCount,
      dryRun,
    },
    results,
  };
}

module.exports = { bulkUpload };
