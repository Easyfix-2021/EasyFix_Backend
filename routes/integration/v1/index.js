const router = require('express').Router();
const multer = require('multer');

const basicAuth = require('../../../middleware/basic-auth');
const { pool } = require('../../../db');
const lookupService = require('../../../services/lookup.service');
const jobService = require('../../../services/job.service');
const { legacyOk, legacyError } = require('../../../utils/response');
const { statusLabel, parseLegacyDate, formatLegacyDate } = require('../../../services/integration.service');
const { writeBuffer } = require('../../../utils/file-storage');

// All /v1/* routes require HTTP Basic Auth against tbl_client_website
router.use(basicAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── /v1/services — Get service catalog ─────────────────────────────
router.get('/services', async (req, res, next) => {
  try {
    const cats = await lookupService.serviceCategories();
    const types = await lookupService.serviceTypes();
    const byCatg = new Map();
    for (const c of cats) {
      byCatg.set(c.service_catg_id, {
        service_catg_id: c.service_catg_id,
        service_catg_name: c.service_catg_name,
        service_catg_desc: c.service_catg_desc,
        category_services: [],
      });
    }
    for (const t of types) {
      const entry = byCatg.get(t.service_catg_id);
      if (!entry) continue;
      entry.category_services.push({
        service_type: {
          service_type_id: t.service_type_id,
          service_type_name: t.service_type_name,
          services: [],  // filled from tbl_client_service scoped to this client
        },
      });
    }
    legacyOk(res, [...byCatg.values()]);
  } catch (e) { next(e); }
});

// ─── /v1/cities — Active cities ─────────────────────────────────────
router.get('/cities', async (req, res, next) => {
  try {
    const cities = await lookupService.cities({ limit: 1000 });
    legacyOk(res, cities.map((c) => ({
      city_id: c.city_id, city_name: c.city_name, state_id: c.state_id,
    })));
  } catch (e) { next(e); }
});

router.get('/serviceType', async (req, res, next) => {
  try { legacyOk(res, await lookupService.serviceTypes()); } catch (e) { next(e); }
});

// ─── /v1/jobs — CREATE ───────────────────────────────────────────────
router.post(['/jobs', '/jobs/newJob'], async (req, res, next) => {
  try {
    const b = req.body || {};
    // Customer + address are inline on the legacy contract
    const customer = b.customer || {};
    const addr = b.address || {};
    const serviceIds = b.service_type?.services?.map((s) => Number(s.service_id)) || [];

    // Convert requested_date from "DD-MM-YYYY HH:mm" to JS Date
    const reqDt = parseLegacyDate(b.requested_date);

    const created = await jobService.create({
      fk_client_id: req.integrationClient.id,
      job_desc: b.jobDesc,
      job_type: b.jobType || 'Installation',
      source_type: b.sourceType || 'integration',
      requested_date_time: reqDt,
      time_slot: b.timeSlot,
      client_ref_id: b.reference_id,
      client_spoc_name: b.clientSpocName,
      client_spoc_email: b.clientSpocEmail,
      client_spoc: b.clientSpocNumber,
      additional_name: b.additionalName,
      additional_number: b.additionalNumber,
      helper_req: !!b.helperReq,
      service_type_ids: serviceIds.join(','),
      customer: {
        customer_name: customer.name,
        customer_mob_no: customer.mobile,
        customer_email: customer.email,
      },
      address: {
        address: addr.address,
        building: addr.building,
        city_id: addr.city?.city_id || null, // legacy sometimes sends by name
        pin_code: addr.pinCode,
        gps_location: addr.gps,
      },
      services: serviceIds.map((id) => ({ service_id: id, quantity: 1 })),
    }, { user_id: null });

    legacyOk(res, { jobId: created.job_id, reference_id: created.client_ref_id });
  } catch (e) {
    if (e.status) return legacyError(res, e.status, e.message);
    next(e);
  }
});

// ─── /v1/jobs/jobStatus?jobId=X — GET status by id ─────────────────
router.get('/jobs/jobStatus', async (req, res, next) => {
  try {
    const jobId = Number(req.query.jobId);
    if (!jobId) return legacyError(res, 400, 'jobId required');
    const job = await jobService.getById(jobId);
    if (!job) return legacyError(res, 404, 'Not Found');
    if (job.fk_client_id !== req.integrationClient.id) {
      return legacyError(res, 403, 'Forbidden');
    }
    legacyOk(res, { jobId: job.job_id, currentStatus: statusLabel(job.job_status) });
  } catch (e) { next(e); }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.integrationClient.id) {
      return legacyError(res, 404, 'Not Found');
    }
    legacyOk(res, {
      jobId: job.job_id,
      status: statusLabel(job.job_status),
      jobType: job.job_type,
      requestedDateTime: formatLegacyDate(job.requested_date_time),
      scheduledDateTime: formatLegacyDate(job.scheduled_date_time),
      easyfixer: job.easyfixer_name,
      clientReferenceId: job.client_ref_id,
    });
  } catch (e) { next(e); }
});

// ─── /v1/jobs — PATCH update (reschedule/schedule/checkin/checkout/reject) ──
router.patch('/jobs', async (req, res, next) => {
  try {
    const { jobId, action } = req.body || {};
    if (!jobId || !action) return legacyError(res, 400, 'jobId and action required');
    const job = await jobService.getById(jobId);
    if (!job || job.fk_client_id !== req.integrationClient.id) return legacyError(res, 404, 'Not Found');

    const map = { schedule: 1, checkin: 2, checkout: 3, reject: 6, reschedule: 1 };
    const newStatus = map[action];
    if (newStatus == null) return legacyError(res, 400, `unknown action "${action}"`);

    const updated = await jobService.setStatus(jobId, { status: newStatus, comment: req.body.comment }, { user_id: null });
    legacyOk(res, { jobId: updated.job_id, status: statusLabel(updated.job_status) });
  } catch (e) { next(e); }
});

// ─── /v1/jobs/{id} — DELETE (cancel) ────────────────────────────────
router.delete('/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.integrationClient.id) return legacyError(res, 404, 'Not Found');
    await jobService.setStatus(job.job_id, { status: 6, comment: 'cancelled via /v1 API' }, { user_id: null });
    legacyOk(res, { jobId: job.job_id, status: 'Cancelled' });
  } catch (e) { next(e); }
});

// ─── /v1/jobs/tracking — search ─────────────────────────────────────
router.get('/jobs/tracking', async (req, res, next) => {
  try {
    const { rows } = await jobService.list({
      clientId: req.integrationClient.id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      limit: Math.min(Number(req.query.limit) || 50, 500),
    });
    legacyOk(res, rows.map((j) => ({
      jobId: j.job_id, status: statusLabel(j.job_status),
      jobType: j.job_type, requestedDateTime: formatLegacyDate(j.requested_date_time),
    })));
  } catch (e) { next(e); }
});

// ─── /v1/jobs/history — date range ──────────────────────────────────
router.get('/jobs/history', async (req, res, next) => {
  try {
    const { rows } = await jobService.list({
      clientId: req.integrationClient.id,
      startDate: req.query.startDate, endDate: req.query.endDate,
      limit: 500,
    });
    legacyOk(res, rows);
  } catch (e) { next(e); }
});

// ─── /v1/jobImage/addJobImages — multipart upload ───────────────────
router.post('/jobImage/addJobImages', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return legacyError(res, 400, 'file required');
    const jobId = Number(req.body.JobId || req.body.jobId);
    if (!jobId) return legacyError(res, 400, 'JobId required');
    const job = await jobService.getById(jobId);
    if (!job || job.fk_client_id !== req.integrationClient.id) return legacyError(res, 404, 'Not Found');

    const saved = writeBuffer('job_files', req.file.buffer, req.file.originalname, req.file.mimetype);
    const [ins] = await pool.query(
      `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, status, created_date)
       VALUES (?, ?, 'unconfirmed', 0, 1, NOW())`,
      [jobId, saved.filename]
    );
    legacyOk(res, {
      imageId: ins.insertId, jobStage: 0, image: saved.filename,
      status: 1, createdTimestamp: formatLegacyDate(new Date()),
      imageCategory: 'unconfirmed',
      createdBy: null, updatedBy: null,
    });
  } catch (e) { next(e); }
});

// ─── Stubs for less-used endpoints ──────────────────────────────────
// These return minimal legacy-shape responses so the contract surface exists.
// Full implementations can be added when a specific integrator requests.
router.get('/easyfixers/availability-status', async (req, res) => {
  legacyOk(res, { available: true, note: 'stub — full impl pending' });
});
router.get('/easyfixers/availability-status-check', async (req, res) => {
  legacyOk(res, { available: true, client: 'generic', note: 'stub — full impl pending' });
});
router.get('/easyfixers', async (req, res) => legacyOk(res, { note: 'stub — use /api/admin/easyfixers', easyfixers: [] }));
router.get('/easyfixers/login', async (req, res) => legacyError(res, 501, 'Not Implemented — use /api/auth/login-otp'));
router.get('/easyfixers/logout', async (req, res) => legacyOk(res, { loggedOut: true }));
router.patch('/easyfixers', async (req, res) => legacyOk(res, { note: 'stub — accepted', ...req.body }));
router.get('/easyfixers/transactions', async (req, res) => legacyOk(res, []));
router.post('/easyfixers/transactions', async (req, res) => legacyOk(res, { accepted: true }));
router.get('/easyfixers/recharges', async (req, res) => legacyOk(res, []));
router.get('/easyfixers/city', async (req, res) => legacyOk(res, []));
router.get('/easyfixers/teamTransactions', async (req, res) => legacyOk(res, []));

// /v1/users/*
router.get('/users/all', async (req, res) => legacyOk(res, []));
router.get('/users/ById', async (req, res) => legacyOk(res, null));
router.get('/users/findUser', async (req, res) => legacyOk(res, null));
router.get('/users/getRecieverByjobId', async (req, res) => legacyOk(res, null));
router.post('/users/saveUserCallInfo', async (req, res) => legacyOk(res, { saved: true }));
router.post('/users/contactUsers', async (req, res) => legacyOk(res, { accepted: true }));

// /v1/utils/*
router.get('/utils/test', async (req, res) => legacyOk(res, { message: 'ok' }));
router.get('/utils/generateOtp', async (req, res) => legacyOk(res, { otp: '1234', note: 'stub — use /api/auth/login-otp' }));
router.get('/utils/validateOtp', async (req, res) => legacyOk(res, { valid: false, note: 'stub' }));
router.post('/utils/notification', async (req, res) => legacyOk(res, { sent: true }));
router.post('/utils/uploadFile', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return legacyError(res, 400, 'file required');
    const saved = writeBuffer('general', req.file.buffer, req.file.originalname, req.file.mimetype);
    legacyOk(res, { filename: saved.filename, url: saved.url });
  } catch (e) { next(e); }
});

// /v1/clients/*
router.get('/clients', async (req, res) => legacyOk(res, []));
router.get('/clients/:id', async (req, res, next) => {
  try {
    const [[c]] = await pool.query('SELECT client_id, client_name, client_email FROM tbl_client WHERE client_id = ?', [req.params.id]);
    legacyOk(res, c || null);
  } catch (e) { next(e); }
});
router.get('/clients/getQuestionaireDetailsList', async (req, res) => legacyOk(res, []));
router.post('/clients/saveQuestionaireAnswers', async (req, res) => legacyOk(res, { saved: true }));

// /v1/customer/*
router.get('/customer/getCustomer', async (req, res, next) => {
  try {
    const { mobile, id } = req.query;
    if (!mobile && !id) return legacyError(res, 400, 'mobile or id required');
    const [[cust]] = await pool.query(
      mobile
        ? 'SELECT customer_id AS id, customer_name AS name, customer_mob_no AS mobile, customer_email AS email FROM tbl_customer WHERE customer_mob_no = ? LIMIT 1'
        : 'SELECT customer_id AS id, customer_name AS name, customer_mob_no AS mobile, customer_email AS email FROM tbl_customer WHERE customer_id = ? LIMIT 1',
      [mobile || id]
    );
    legacyOk(res, cust || null);
  } catch (e) { next(e); }
});
router.post('/customer/addCustomer', async (req, res, next) => {
  try {
    const { name, mobile, email } = req.body || {};
    if (!name || !mobile) return legacyError(res, 400, 'name and mobile required');
    const [ins] = await pool.query(
      'INSERT INTO tbl_customer (customer_name, customer_mob_no, customer_email, is_active, insert_date, update_date) VALUES (?, ?, ?, 1, NOW(), NOW())',
      [name, mobile, email || null]
    );
    legacyOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});
router.put('/customer', async (req, res, next) => {
  try {
    const { id, name, email } = req.body || {};
    if (!id) return legacyError(res, 400, 'id required');
    await pool.query('UPDATE tbl_customer SET customer_name = COALESCE(?, customer_name), customer_email = COALESCE(?, customer_email), update_date = NOW() WHERE customer_id = ?', [name, email, id]);
    legacyOk(res, { updated: true });
  } catch (e) { next(e); }
});
router.get('/customer/jobs', async (req, res, next) => {
  try {
    const custId = Number(req.query.customerId);
    const [rows] = await pool.query('SELECT job_id, job_status, created_date_time FROM tbl_job WHERE fk_customer_id = ? ORDER BY job_id DESC LIMIT 100', [custId]);
    legacyOk(res, rows.map((j) => ({ ...j, status: statusLabel(j.job_status) })));
  } catch (e) { next(e); }
});

// /v1/clientInvoice
router.get('/clientInvoice', async (req, res) => legacyOk(res, []));

// /v1/userLog
router.get('/userLog/findAll', async (req, res) => legacyOk(res, []));
router.get('/userLog/download', async (req, res) => legacyOk(res, { note: 'use CRM export' }));

module.exports = router;
