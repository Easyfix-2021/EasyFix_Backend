const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');
const jobLocation = require('./job-location.service');
const smsService = require('./sms.service');
const gallabox = require('./gallabox.whatsapp.service');

/*
 * The approved Gallabox template that carries the job-closing PIN.
 *
 * Deliberately NOT defaulted to a guess. Gallabox answers 200 for a template
 * name it does not recognise and the handset simply never receives anything —
 * so a wrong name here is a SILENT non-delivery that no delivery check can
 * catch. Unset means "fall back to SMS and say so in the log", which is visibly
 * broken rather than invisibly broken.
 */
const CLOSING_PIN_TEMPLATE = String(process.env.GALLABOX_CLOSING_PIN_TEMPLATE || '').trim();

/*
 * Mobile Job Lifecycle — the technician-app order flow that sits on top
 * of the shared jobService transitions:
 *
 *   cancel        → job_status 6  (CANCELLED)
 *   checkin-sms   → (re)send the customer the check-in PIN SMS
 *   selfie        → store the reached-location selfie ref on the job
 *   search        → find the tech's job by id (dashboard search)
 *
 * NOTE: `startWork` (→ IN_PROGRESS) and `complete` (→ COMPLETED/REVISIT)
 * were removed as duplicates of POST /jobs/:id/checkin and
 * POST /jobs/:id/checkout (which already own those transitions).
 *
 * Every mutation is scoped to the authed technician's efr_id: the caller
 * (routes/mobile/jobs-lifecycle.js) verifies fk_easyfixter_id === efr_id
 * BEFORE invoking these functions, but each write here ALSO pins
 * `fk_easyfixter_id = ?` in the WHERE clause as a second guard so a
 * tech can never mutate another tech's job even if the route check is
 * bypassed in future.
 *
 * Schema notes (verified against EasyFix_CRM JobDaoImpl.java mapper +
 * the legacy mobile API contract /tmp/deepskill-src/lib/src/api/app_api.dart):
 *   - fk_easyfixter_id            legacy typo, preserved.
 *   - cancel_reason_id / cancel_comment / cancel_by / cancel_date_time
 *                                 CANCELLED stamps (also stamped by
 *                                 jobService.setStatus — we route cancel
 *                                 through it so the CancelJob webhook +
 *                                 customer SMS fire from one place).
 *   - tx_selfie_id                FK to `document.id` for the reached-
 *                                 location selfie (JobDaoImpl.java:1874).
 *   - is_collected_cash_by_app    BIT — cash collected on this visit.
 *   - collect_cash_reason_id      FK collect_cash_reason_by_app.id.
 *   - material_charge             amount collected (legacy `materialCharge`).
 *   - problem_reason_id           FK problem_with_job_reason.id.
 *   - revisit_reason_id           FK revisit_reason_by_app.id.
 *   - revisit_date / revisit_time_slot   next-visit appointment.
 *
 * All column writes are probe-gated so a partially-migrated deploy
 * degrades gracefully (skips the missing column, never 500s).
 */

const STATUS_CANCELLED = 6;

// ─── Column-existence probes (cached per-process) ───────────────────
/*
 * Mirrors the probe pattern in job.service.js / job-comment.service.js:
 * INFORMATION_SCHEMA lookup, cached, soft-fail-to-false so an
 * un-migrated deploy skips the column instead of breaking the write.
 */
const _colCache = {};
async function hasJobColumn(colName) {
  if (_colCache[colName] != null) return _colCache[colName];
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME  = ?
        LIMIT 1`,
      [colName],
    );
    _colCache[colName] = rows.length > 0;
    return _colCache[colName];
  } catch (e) {
    /*
     * Soft-fail to false is right for two of the three callers — cancel()
     * only mirrors an optional reason/flag for legacy reports, and the status
     * transition has already committed. It is wrong to make that PERMANENT.
     *
     * The old bare `catch { _colCache[colName] = false; }` did exactly that:
     * the memo guard is `!= null`, and `false != null`, so one transient
     * information_schema error pinned the column as missing for the rest of
     * the process. saveSelfie turns a false into a hard 501 "selfie column not
     * present on this deployment" — a claim that is simply untrue, since
     * tx_selfie_id is present in production. A technician could not upload a
     * reached-location selfie again until the container restarted.
     *
     * Not cached now, so the next call re-probes and the 501 is at worst a
     * retryable blip. The bare catch also swallowed the error with no log at
     * all, which is why this left no trace to find.
     */
    logger.warn('tbl_job column probe failed · ' + colName + ' · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
}

// ─── Ownership guard ─────────────────────────────────────────────────
/*
 * Fetch the minimal job row + confirm it belongs to the technician.
 * Returns the row when owned, or throws a tagged error (.status) the
 * route maps to the right HTTP code. Single indexed lookup — no joins.
 */
async function getOwnedJob(jobId, efrId) {
  const [[row]] = await pool.query(
    `SELECT job_id, job_status, fk_easyfixter_id, fk_customer_id, fk_client_id, otp
       FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!row) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  if (Number(row.fk_easyfixter_id) !== Number(efrId)) {
    // 404 (not 403) so a tech can't probe which job ids exist.
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  return row;
}

// ─── Cancel (legacy actionType 27) ──────────────────────────────────
/*
 * POST /jobs/:id/cancel { reason, reasonId }
 *
 * Routes through jobService.setStatus(CANCELLED) so the shared path owns
 * the cancel_* stamps + the CancelJob webhook + the customer SMS. The
 * legacy mobile endpoint was `easyfixer-call-record/cancel` with
 * actionType=27; the cancel-by-app reason id maps to cancel_reason_id
 * and the free-text comment to cancel_comment.
 *
 * `reasonId` is the FK into the app's cancel-reason list
 * (job_cancel_reason_by_easyfixer_app). We ALSO mirror it onto the
 * legacy app-specific column job_cancel_reason_id_by_easyfixer (probe-
 * gated) so the CRM "cancelled by app" reporting keeps working.
 */
async function cancel(jobId, efrId, { reason, reasonId }) {
  logger.info('Cancel job · jobId=' + jobId + ' reasonId=' + (reasonId ?? '-'));
  await getOwnedJob(jobId, efrId);

  await jobService.setStatus(
    jobId,
    { status: STATUS_CANCELLED, reasonId: reasonId || null, comment: reason || null },
    // `efr_id` names the namespace `user_id` is carrying. Legacy columns
    // (cancel_by, fk_checkout_by, commented_by) read user_id and keep storing an
    // efr id in a tbl_user slot — a live defect this does not change. What it
    // does is stop that ambiguity reaching tbl_job_logs.changed_by, where
    // services/job-log.service.js uses efr_id to keep a technician out of a
    // column that must only ever hold a tbl_user id.
    { user_id: efrId, efr_id: efrId },
  );

  // Mirror the app-specific cancel reason + flag for legacy CRM reports.
  // Soft-fail: the status transition already committed via setStatus;
  // this mirror is a reporting convenience, not a correctness gate.
  try {
    const sets = [];
    const vals = [];
    if (reasonId != null && await hasJobColumn('job_cancel_reason_id_by_easyfixer')) {
      sets.push('job_cancel_reason_id_by_easyfixer = ?');
      vals.push(Number(reasonId));
    }
    if (await hasJobColumn('is_cancelled_by_app')) {
      sets.push('is_cancelled_by_app = 1');
    }
    if (sets.length) {
      vals.push(jobId, efrId);
      await pool.query(
        `UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ? AND fk_easyfixter_id = ?`,
        vals,
      );
    }
  } catch (mirrorErr) {
    logger.warn('Cancel app-reason mirror failed (job already cancelled) · jobId=' + jobId + ' · ' + mirrorErr.message);
    logger.warn({ err: mirrorErr.message, jobId, efrId }, 'cancel: app-reason mirror failed (job already cancelled)');
  }

  logger.info('Job cancelled · jobId=' + jobId);
  return { cancelled: true };
}

// ─── Check-in PIN SMS ────────────────────────────────────────────────
/*
 * POST /jobs/:id/checkin-sms
 *
 * (Re)sends the customer the check-in PIN (the 4-digit code stamped on
 * tbl_job.otp at order confirmation — see job.service.js setStatus
 * BOOKED branch). The technician asks the customer to read it back to
 * verify they're at the right doorstep. Legacy endpoint was
 * `jobs/check-in-sms-customer/{jobId}`.
 *
 * Reuses the existing SMS template service (job_stage='CHECK_IN', falling
 * back to inline text when no DLT template row exists — mirrors the
 * notification-orchestrator fallback pattern) + sms.service.send.
 */
async function sendCheckinSms(jobId, efrId) {
  logger.info('Send check-in PIN SMS · jobId=' + jobId);
  await getOwnedJob(jobId, efrId);

  // Pull the customer's mobile + the PIN in one indexed join, plus the two
  // names the WhatsApp template addresses the customer and the technician by.
  const [[row]] = await pool.query(
    `SELECT cu.customer_mob_no,
            cu.customer_name,
            COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS display_name,
            ef.efr_name AS technician_name,
            j.otp, j.fk_client_id
       FROM tbl_job j
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_easyfixer ef ON ef.efr_id = j.fk_easyfixter_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!row || !row.customer_mob_no) {
    const e = new Error('customer mobile not on file for this job');
    e.status = 422; throw e;
  }
  const pin = row.otp != null && String(row.otp).trim() !== '' ? String(row.otp).trim() : null;
  if (!pin) {
    // No PIN minted yet (job never went through the BOOKED-confirm path).
    const e = new Error('no check-in PIN available for this job');
    e.status = 422; throw e;
  }

  /*
   * ── WHY THIS IS WHATSAPP NOW, AND WHY THE SMS PATH STAYS ──────────────────
   *
   * This used to ask sms-template.service for job_stage 'CHECK_IN'. That row
   * does not exist — measured against the live table, `job_stage = 'CHECK_IN'`
   * returns ZERO rows (the registered keys are lowerCamelCase: 'checkin',
   * 'checkInBeforeTime', 'checkInAfterTime'). So the lookup always returned
   * null, the inline fallback below it always won, and an UNREGISTERED body
   * went on the wire. Indian DLT scrubs an unregistered body at the aggregator:
   * every one of these was "Rejected, 0 INR" in the SMS Country console.
   *
   * It went unnoticed for months because nothing here could see it — the send
   * result was discarded and this function returned { sent: true } regardless,
   * so the app and the CRM's Resend button both reported success on a message
   * the provider had thrown away. That is fixed below too: the channel and the
   * delivery outcome are returned.
   *
   * And there is no correct SMS template to switch to. Every registered PIN
   * template says "to START the service" (resendJobPin, resendJobPinNew,
   * mobileCustomerOtp) because the PIN used to start the job; commit 1d69ff0
   * (2026-09-07) made it CLOSE the job instead. Rather than send words that
   * contradict the action, the closing PIN moves to WhatsApp, where the
   * template is ours to word correctly.
   *
   * SMS remains the fallback for a customer WhatsApp cannot reach.
   */
  const customerName = String(row.display_name || '').trim() || 'there';
  const technicianName = String(row.technician_name || '').trim() || 'our technician';

  let channel = 'sms';
  let delivered = false;

  if (CLOSING_PIN_TEMPLATE) {
    /*
     * Positional binding, matching the registered body:
     *   Hi {{1}}, your EasyFix *Job #{{2}}* is ready to be closed. Our
     *   technician {{3}} will ask you for this PIN to complete the visit: {{4}}
     * The shape must match how the template was registered — this repo already
     * carries the scar that positional keys against a NAMED template bind to
     * nothing and deliver "Hello []".
     */
    const wa = await gallabox.sendTemplate({
      to: row.customer_mob_no,
      recipientName: String(row.customer_name || '').trim(),
      templateName: CLOSING_PIN_TEMPLATE,
      bodyValues: { 1: customerName, 2: String(jobId), 3: technicianName, 4: pin },
    });
    if (wa.delivered) {
      logger.info('Closing PIN sent on WhatsApp · jobId=' + jobId);
      return { sent: true, channel: 'whatsapp', delivered: true };
    }
    if (wa.disabled) return { sent: false, channel: 'whatsapp', delivered: false, disabled: true };
    logger.warn(
      'Closing-PIN WhatsApp not delivered, falling back to SMS · jobId=' + jobId
      + ' · ' + (wa.error || 'httpStatus=' + wa.httpStatus),
    );
  } else {
    logger.warn(
      'GALLABOX_CLOSING_PIN_TEMPLATE is not set — the closing PIN is going out over '
      + 'SMS, which DLT currently rejects. Set it to the approved Gallabox template '
      + 'name. jobId=' + jobId,
    );
  }

  /*
   * The SMS fallback is deliberately the shortest sentence that still says what
   * the PIN is FOR. It remains unregistered with DLT and will very likely be
   * rejected — but a rejected fallback that is logged honestly is better than a
   * silent one, and the WhatsApp path above is the route that works.
   */
  const smsResult = await smsService.send({
    to: row.customer_mob_no,
    message: `EasyFix: Your job closing PIN is ${pin}. Share it only with the technician at your door.`,
  });
  delivered = Boolean(smsResult && smsResult.delivered);
  if (!delivered) {
    logger.warn('Closing-PIN SMS not delivered either · jobId=' + jobId);
  }
  return { sent: delivered, channel, delivered };
}

// ─── Reached-location geofence ───────────────────────────────────────
/*
 * The device fix the technician actually reported. Two shapes reach us and
 * both are optional:
 *   - `geofence: { latitude, longitude, … }` — the 2026-09-07 contract;
 *   - top-level `latitude` / `longitude` — what the app has been sending to
 *     this endpoint all along (Joi's stripUnknown was silently dropping them).
 * The block wins when present. Returns null when there is no usable fix, and
 * null means SKIP — never "outside".
 */
function resolveDeviceFix({ latitude, longitude, geofence }) {
  const lat = geofence && geofence.latitude != null ? geofence.latitude : latitude;
  const lng = geofence && geofence.longitude != null ? geofence.longitude : longitude;
  if (lat == null || lng == null) return null;
  const latitudeNum = Number(lat);
  const longitudeNum = Number(lng);
  if (!Number.isFinite(latitudeNum) || !Number.isFinite(longitudeNum)) return null;
  // (0,0) is the Gulf of Guinea — what a device with no fix degrades to, and
  // never a real arrival. Treat it as "no fix" rather than as 8,000 km outside.
  if (latitudeNum === 0 && longitudeNum === 0) return null;
  return { latitude: latitudeNum, longitude: longitudeNum };
}

/*
 * Evaluate the arrival fix against the site, enforce if ops has asked for it,
 * and record the result.
 *
 * SOFT BY DEFAULT: the server records and never rejects. Hard mode
 * (easyfix_properties `geofence.enforcement.enabled` = 'true') rejects with 400
 * ONLY when the server itself computed "outside" AND no override reason was
 * given. Every other combination proceeds, including:
 *   - the site has no coordinates            → nothing to compare against
 *   - the device sent no fix                 → nothing to compare with
 *   - outside the fence WITH a reason        → the audited override
 * i.e. missing data never blocks a job start, which is the product rule.
 *
 * The verdict is the SERVER's, computed from the raw device coordinates. The
 * client's own distanceMeters / withinFence claims are recorded nowhere and
 * decide nothing — a gate that reads a boolean supplied by the thing being
 * gated is not a gate. A divergence between the two is logged, because that is
 * the signal that an app build is computing the fence differently from us.
 */
async function recordArrivalGeofence(jobId, efrId, device, claimed) {
  const [[row]] = await pool.query(
    `SELECT ad.gps_location
       FROM tbl_job j
       LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  const verdict = jobLocation.evaluateGeofence(row && row.gps_location, device);
  const overrideReason = claimed && claimed.overrideReason
    ? String(claimed.overrideReason).trim() : '';

  if (!verdict) {
    logger.info('Arrival geofence not evaluated · jobId=' + jobId
      + ' · ' + (row && row.gps_location ? 'device fix unusable' : 'site has no coordinates')
      + ' — recording position only, not blocking');
  } else {
    logger.info('Arrival geofence · jobId=' + jobId
      + ' · distance=' + verdict.distanceMeters + 'm'
      + ' · radius=' + verdict.radiusMeters + 'm'
      + ' · within=' + verdict.withinFence
      + ' · override=' + (overrideReason ? 'yes' : 'no'));
    if (claimed && claimed.withinFence != null && Boolean(claimed.withinFence) !== verdict.withinFence) {
      logger.warn('Arrival geofence verdict differs from the app\'s · jobId=' + jobId
        + ' · app=' + Boolean(claimed.withinFence) + ' · server=' + verdict.withinFence
        + ' — the server verdict is authoritative');
    }
  }

  /*
   * Recorded on tbl_job_location_track — the EasyFix-owned live-track table the
   * CRM already reads for "where is my technician", indexed on (job_id,
   * captured_at). The arrival row is the one with within_fence NOT NULL; the
   * ops abuse report is `WHERE within_fence = 0 AND override_reason IS NOT NULL`.
   * Best-effort: an audit write must never be what stops a technician working.
   */
  try {
    await jobLocation.addPing(jobId, efrId, {
      latitude: device.latitude,
      longitude: device.longitude,
      accuracy: null,
      geofence: verdict
        ? { ...verdict, overrideReason: overrideReason || null }
        : { distanceMeters: null, withinFence: null, overrideReason: overrideReason || null },
    });
  } catch (e) {
    logger.warn('Arrival geofence audit write failed · jobId=' + jobId + ' · ' + e.message
      + ' — continuing, the technician is not blocked by an audit failure');
  }

  /*
   * Enforcement runs AFTER the audit write, deliberately. A blocked attempt is
   * the single most interesting row ops can have, and throwing before the
   * INSERT would make exactly those attempts the ones that leave no trace.
   * Blocked rows are `within_fence = 0 AND override_reason IS NULL`, so they
   * sit beside the overrides without polluting the override report.
   */
  if (verdict && !verdict.withinFence && !overrideReason && jobLocation.enforcementEnabled()) {
    logger.warn('Arrival BLOCKED, outside fence with no reason · jobId=' + jobId
      + ' · distance=' + verdict.distanceMeters + 'm');
    const e = new Error(
      'You are ' + Math.round(verdict.distanceMeters) + 'm from the job location '
      + '(allowed ' + Math.round(verdict.radiusMeters) + 'm). Add a reason to continue.',
    );
    e.status = 400;
    throw e;
  }
}

// ─── Reached-location selfie ─────────────────────────────────────────
/*
 * POST /jobs/:id/selfie { selfieImageId }
 *
 * Stores the reached-location selfie reference on the job. The selfie
 * file is uploaded separately (the app POSTs the image, gets back a
 * document id, then calls this with that id). Maps to tbl_job.tx_selfie_id
 * (FK document.id — JobDaoImpl.java:1874). Legacy endpoint:
 * `jobs/upload-selfie` with body { jobId, selfieId }.
 *
 * Not a status transition — a plain owned-row UPDATE.
 */
async function saveSelfie(jobId, efrId, { selfieImageId, latitude, longitude, geofence }) {
  logger.info('Save reached-location selfie · jobId=' + jobId + ' selfieImageId=' + selfieImageId);
  await getOwnedJob(jobId, efrId);

  /*
   * ── GEOFENCE (2026-09-07), ENTIRELY ADDITIVE ────────────────────────────
   *
   * Runs FIRST, before the tx_selfie_id write, so a hard-mode rejection cannot
   * leave the job half-mutated.
   *
   * A caller that sends no device coordinates — every caller that exists today,
   * and the CRM forever — takes ZERO new work: no address lookup, no INSERT,
   * no property read, no new failure mode. The function then behaves byte-for-
   * byte as it did before this change. That equivalence is the point of the
   * whole task and it is pinned by a test
   * (tests/mobile-reached-location-geofence.test.js).
   */
  const device = resolveDeviceFix({ latitude, longitude, geofence });
  if (device) {
    await recordArrivalGeofence(jobId, efrId, device, geofence);
  }

  if (!(await hasJobColumn('tx_selfie_id'))) {
    // VERIFY: tx_selfie_id confirmed on legacy schema; if a deploy lacks
    // it the selfie ref simply isn't persisted (image upload still
    // succeeded out-of-band). Surface a clear error rather than a silent
    // no-op so the gap is visible in QA.
    const e = new Error('selfie column not present on this deployment');
    e.status = 501; throw e;
  }

  await pool.query(
    `UPDATE tbl_job SET tx_selfie_id = ?, last_update_time = ?
      WHERE job_id = ? AND fk_easyfixter_id = ?`,
    [Number(selfieImageId), new Date(), jobId, efrId],
  );
  logger.info('Selfie ref saved · jobId=' + jobId);
  return { ok: true };
}

// ─── Dashboard search by job id ─────────────────────────────────────
/*
 * GET /jobs/search?jobId=
 *
 * Finds the technician's job by id for the dashboard search bar. Returns
 * a compact camelCase detail summary (NOT the full getById payload — the
 * search result card only needs the headline fields). Scoped to the
 * authed tech: a job belonging to someone else returns null, identical
 * to "not found", so a tech can't enumerate other techs' jobs.
 *
 * customerName (2026-08-03): this card describes a JOB, so it shows the
 * per-job name captured on the booking form (tbl_job.job_customer_name)
 * and only falls back to the customer master when that is absent.
 * NULLIF(TRIM(...), '') is required — a plain COALESCE would render a
 * BLANK name for a '' job_customer_name, which job.validator.js still
 * permits on both the create and update paths.
 */
async function searchByJobId(jobId, efrId) {
  logger.info('Search job by id · jobId=' + jobId);
  const [[row]] = await pool.query(
    `SELECT j.job_id, j.job_reference_id, j.client_ref_id, j.job_status,
            j.job_type, j.requested_date_time, j.time_slot, j.otp,
            COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
            cu.customer_mob_no,
            ad.address, ad.locality, ad.landmark, ad.pin_code, ad.gps_location,
            ci.city_name,
            cl.client_name,
            sc.service_catg_name AS service_category
       FROM tbl_job j
       LEFT JOIN tbl_customer    cu ON cu.customer_id     = j.fk_customer_id
       LEFT JOIN tbl_address     ad ON ad.address_id       = j.fk_address_id
       LEFT JOIN tbl_city        ci ON ci.city_id          = ad.city_id
       LEFT JOIN tbl_client      cl ON cl.client_id        = j.fk_client_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
      WHERE j.job_id = ? AND j.fk_easyfixter_id = ?
      LIMIT 1`,
    [jobId, efrId],
  );
  if (!row) logger.info('Search found no job · jobId=' + jobId);
  if (!row) return null;
  logger.info('Search matched job · jobId=' + jobId + ' status=' + row.job_status);
  return {
    jobId:           row.job_id,
    jobReferenceId:  row.job_reference_id,
    clientRefId:     row.client_ref_id,
    jobStatus:       row.job_status,
    jobType:         row.job_type,
    requestedAt:     row.requested_date_time,
    timeSlot:        row.time_slot,
    checkinPin:      row.otp ?? null,
    customerName:    row.customer_name,
    customerMobile:  row.customer_mob_no,
    address:         row.address,
    locality:        row.locality,
    landmark:        row.landmark,
    pincode:         row.pin_code,
    gpsLocation:     row.gps_location,
    city:            row.city_name,
    clientName:      row.client_name,
    serviceCategory: row.service_category,
  };
}

/*
 * POST /jobs/:id/location { latitude, longitude, accuracy? }
 *
 * Append a real-time GPS ping to the job's live track (tbl_job_location_track)
 * for the CRM map. getOwnedJob 404s if it isn't this tech's job, so a tech can
 * only post locations for their own active jobs. The point-in-time
 * checkin_gps_location on tbl_job is unaffected — this is the continuous trail.
 */
/*
 * Statuses a location ping is accepted for — the window from the technician
 * ACCEPTING the job to finishing it.
 *
 * ─── WHY AN ALLOWLIST AND NOT `status < 3` ─────────────────────────────────
 *
 * A 409 here is not a soft failure: the app's background task treats it as
 * "stop tracking" and self-terminates (src/lib/native/backgroundLocation.ts).
 * That is the ONLY stop that works while the app is backgrounded with no
 * screen mounted, so every terminal state MUST still 409. A range check would
 * quietly admit any future status numbered below the terminal ones and break
 * that guarantee without anyone noticing.
 *
 * SCHEDULED (1) is the accept→check-in window: the technician has taken the
 * job and is travelling to it. It used to be rejected, which is why the CRM
 * trail was empty for exactly the period an operator most wants it.
 *
 * IN_PROGRESS_ALT (20) is a genuine checked-in state (jobService's
 * CHECKED_IN_STATES pairs it with 2), and the CRM has always offered the Live
 * Location button for it — so a strict `!== 2` meant an operator could open a
 * popover for a status-20 job whose pings the server was rejecting, and that
 * 409 permanently killed the technician's tracker. Fixed here.
 *
 * DELIBERATELY EXCLUDED: ESTIMATE_PENDING_APPROVAL (15) and ON_HOLD (21).
 * Both are real mid-job pauses, and both therefore stop tracking for good —
 * a job that returns 21 → 2 only resumes when a screen mounts. That is the
 * pre-existing behaviour for every non-2 status, not a regression, and
 * widening it is a product decision about whether to track a technician who
 * is not working.
 */
const LOCATION_PING_STATES = new Set([
  jobService.STATUS.SCHEDULED,      // 1  — accepted, travelling
  jobService.STATUS.IN_PROGRESS,    // 2  — checked in, working
  jobService.STATUS.IN_PROGRESS_ALT, // 20 — the other checked-in state
]);

async function recordLocationPing(jobId, efrId, ping) {
  logger.info('Record location ping · jobId=' + jobId);
  const job = await getOwnedJob(jobId, efrId); // 404 if not the tech's job
  if (!LOCATION_PING_STATES.has(Number(job.job_status))) {
    logger.warn('Location ping rejected, job outside tracking window · jobId=' + jobId + ' status=' + job.job_status);
    const e = new Error('job not in progress'); e.status = 409; throw e;
  }
  return jobLocation.addPing(jobId, efrId, ping);
}

// ─── Questionnaire (recce checklist) ────────────────────────────────
/*
 * GET /jobs/:id/questionnaire — the yes/no checklist for a job, with any saved
 * answers pre-filled. tbl_job.fk_questionaire_id picks the questionnaire;
 * tbl_questionaire_details holds the questions (status=1, ordered by seq);
 * tbl_questionaire_answer holds this job's answers. Returns [] when the job has
 * no questionnaire assigned. Answers fetched separately + last-write-wins so
 * legacy duplicate answer rows collapse cleanly.
 */
async function getQuestionnaire(jobId, efrId) {
  logger.info('Get questionnaire · jobId=' + jobId);
  const [[job]] = await pool.query(
    `SELECT fk_questionaire_id, fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!job || Number(job.fk_easyfixter_id) !== Number(efrId)) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  const qid = job.fk_questionaire_id;
  if (!qid) logger.info('No questionnaire assigned · jobId=' + jobId);
  if (!qid) return [];

  const [questions] = await pool.query(
    `SELECT c_qd_id, c_qd_text, c_qd_mandatory, c_qd_seq
       FROM tbl_questionaire_details
      WHERE c_questionaire_id = ? AND status = 1
      ORDER BY c_qd_seq ASC`,
    [qid],
  );
  const [answers] = await pool.query(
    `SELECT c_qd_id, c_qd_ans, c_qd_comments
       FROM tbl_questionaire_answer
      WHERE job_id = ?
      ORDER BY c_qd_ans_id ASC`,
    [jobId],
  );
  logger.info('Found ' + questions.length + ' questions, ' + answers.length + ' saved answers · jobId=' + jobId);
  const ansByQ = new Map();
  for (const a of answers) ansByQ.set(Number(a.c_qd_id), a); // ASC → last wins
  const yes = (v) => /^(1|yes|y|true)$/i.test(String(v == null ? '' : v).trim());
  return questions.map((q) => {
    const a = ansByQ.get(Number(q.c_qd_id));
    return {
      id:        q.c_qd_id,
      question:  q.c_qd_text,
      mandatory: Number(q.c_qd_mandatory) === 1,
      answer:    a && a.c_qd_ans != null ? yes(a.c_qd_ans) : undefined,
      remark:    a && a.c_qd_comments ? a.c_qd_comments : undefined,
    };
  });
}

/*
 * POST /jobs/:id/questionnaire { answers:[{questionId, answer(bool), remark?}] }
 * Upsert by (job_id, c_qd_id) — re-submitting overwrites instead of duplicating
 * (legacy did a plain INSERT). Answer stored as '1'/'0'; both NOT-NULL text
 * columns are always supplied. inserted_by left 0 (the column default) — efr_id
 * is a tbl_easyfixer id, not the tbl_user id inserted_by may key on, so we don't
 * stamp it to avoid a wrong-table reference.
 */
async function submitQuestionnaire(jobId, efrId, answers) {
  logger.info('Submit questionnaire · jobId=' + jobId + ' answers=' + (Array.isArray(answers) ? answers.length : 0));
  const [[job]] = await pool.query(
    `SELECT fk_questionaire_id, fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!job || Number(job.fk_easyfixter_id) !== Number(efrId)) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  const qid = job.fk_questionaire_id;
  if (!qid) { const e = new Error('no questionnaire for this job'); e.status = 409; throw e; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const a of answers) {
      const ansStr = a.answer ? '1' : '0';
      const remark = a.remark || '';
      const [[existing]] = await conn.query(
        `SELECT c_qd_ans_id FROM tbl_questionaire_answer WHERE job_id = ? AND c_qd_id = ? LIMIT 1`,
        [jobId, a.questionId],
      );
      if (existing) {
        await conn.query(
          `UPDATE tbl_questionaire_answer SET c_qd_ans = ?, c_qd_comments = ?, update_date = NOW()
            WHERE c_qd_ans_id = ?`,
          [ansStr, remark, existing.c_qd_ans_id],
        );
      } else {
        await conn.query(
          `INSERT INTO tbl_questionaire_answer (c_qd_id, job_id, c_questionaire_id, c_qd_ans, c_qd_comments, inserted_by)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [a.questionId, jobId, qid, ansStr, remark],
        );
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.warn('Submit questionnaire failed, rolled back · jobId=' + jobId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
  logger.info('Questionnaire saved · jobId=' + jobId);
  return { ok: true };
}

// ─── Work progress ──────────────────────────────────────────────────
/*
 * GET /jobs/:id/work-progress — the completion-stage snapshot the app renders
 * (problem / cash / revisit). All fields read straight off tbl_job. There is no
 * is_next_visit column → isNextVisit is derived from job_status === 10 (REVISIT).
 */
async function getWorkProgress(jobId, efrId) {
  logger.info('Get work progress · jobId=' + jobId);
  const [[r]] = await pool.query(
    `SELECT job_id, job_status, problem_reason_id, is_collected_cash_by_app,
            material_charge, collect_cash_reason_id, revisit_reason_id,
            revisit_date, revisit_time_slot, fk_easyfixter_id
       FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!r || Number(r.fk_easyfixter_id) !== Number(efrId)) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  const cashBit = Buffer.isBuffer(r.is_collected_cash_by_app)
    ? r.is_collected_cash_by_app[0] === 1
    : Number(r.is_collected_cash_by_app) === 1;
  return {
    jobId:           r.job_id,
    haveProblem:     Number(r.problem_reason_id) > 0,
    problemReasonId: r.problem_reason_id || undefined,
    isCashCollected: cashBit,
    collectedAmount: r.material_charge || undefined,
    cashReasonId:    r.collect_cash_reason_id || undefined,
    isNextVisit:     Number(r.job_status) === 10,
    revisitDateTime: r.revisit_date || undefined,
    revisitTime:     r.revisit_time_slot || undefined,
    revisitReasonId: r.revisit_reason_id || undefined,
  };
}

module.exports = {
  cancel,
  sendCheckinSms,
  saveSelfie,
  searchByJobId,
  recordLocationPing,
  getQuestionnaire,
  submitQuestionnaire,
  getWorkProgress,
};
