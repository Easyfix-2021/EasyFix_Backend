const router  = require('express').Router();
const Joi     = require('joi');
const multer  = require('multer');

const validate    = require('../../middleware/validate');
const zone        = require('../../services/zone.service');
const zoneUpload  = require('../../services/zone-upload.service');
const { modernOk, modernError } = require('../../utils/response');

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const createBody = Joi.object({
  zone_name: Joi.string().trim().min(2).max(100).required(),
});

const updateBody = Joi.object({
  zone_name:   Joi.string().trim().min(2).max(100).optional(),
  zone_status: Joi.boolean().optional(),
}).min(1);

const cityMapBody = Joi.object({
  city_ids: Joi.array().items(Joi.number().integer().positive()).max(2000).required(),
});

const searchQuery  = Joi.object({
  q:          Joi.string().allow('', null).optional(),
  limit:      Joi.number().integer().min(1).max(500).default(200),
  activeOnly: Joi.boolean().default(true),
});
const pincodeQuery = Joi.object({
  pincode: Joi.string().pattern(/^\d{6}$/).required(),
  limit:   Joi.number().integer().min(1).max(500).default(200),
});
const uploadQuery  = Joi.object({
  dryRun: Joi.boolean().default(false),
});

// ─── Multer (in-memory, .xlsx/.xls only, 5 MB) ──────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .xlsx / .xls files are accepted'));
  },
});

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', async (_req, res, next) => {
  try { modernOk(res, await zone.listZones()); } catch (e) { next(e); }
});

/*
 * Pincode-first lookup — listed BEFORE `/:id` so Express doesn't capture
 * the literal "by-pincode" as a zoneId. Same route-order gotcha as
 * /auto-assign and /jobs-upload (declared before /jobs/:id).
 */
router.get('/by-pincode', validate(pincodeQuery, 'query'), async (req, res, next) => {
  try {
    const items = await zone.searchEasyfixersByPincode(req.query.pincode, { limit: req.query.limit });
    modernOk(res, { pincode: req.query.pincode, easyfixers: items });
  } catch (e) { next(e); }
});

/*
 * GET /api/admin/zones/template — downloadable .xlsx with locked Zones
 * Master + Cities Master sheets and dropdown validation on the editable
 * Mapping sheet. Listed BEFORE `/:id` for the same reason as above.
 */
router.get('/template', async (_req, res, next) => {
  try {
    const buf = await zoneUpload.generateTemplate();
    res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="easyfix-zone-mapping-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await zone.getZoneDetail(req.params.id);
    if (!data) return modernError(res, 404, 'zone not found');
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.get('/:id/easyfixers', validate(idParam, 'params'), validate(searchQuery, 'query'), async (req, res, next) => {
  try {
    const items = await zone.searchEasyfixersInZone(req.params.id, req.query);
    modernOk(res, items);
  } catch (e) { next(e); }
});

// ─── WRITE (create / update / set city mapping) ─────────────────────
router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const created = await zone.createZone(req.body);
    res.status(201);
    modernOk(res, created, 'zone created');
  } catch (e) { next(e); }
});

router.patch('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    const updated = await zone.updateZone(Number(req.params.id), req.body);
    modernOk(res, updated, 'zone updated');
  } catch (e) { next(e); }
});

/*
 * PATCH /:id/cities — replace the zone's city set in one shot. The body
 * is { city_ids: [int, …] }. Empty array clears the mapping (use with
 * care — see service note about orphaned easyfixers).
 */
router.patch('/:id/cities', validate(idParam, 'params'), validate(cityMapBody), async (req, res, next) => {
  try {
    const result = await zone.setCityMapping(Number(req.params.id), req.body.city_ids);
    modernOk(res, result, 'cities mapped');
  } catch (e) { next(e); }
});

// ─── BULK upload (xlsx) ──────────────────────────────────────────────
/*
 * POST /api/admin/zones/upload?dryRun=true|false
 * multipart field name: file   .xlsx/.xls only, max 5 MB
 *
 * Response shape mirrors the jobs-upload endpoint for UI parity:
 *   { summary: { totalRows, validRows, invalidRows, applied, skipped, dryRun },
 *     results: [{ rowNumber, status, reason? }] }
 */
router.post('/upload',
  upload.single('file'),
  validate(uploadQuery, 'query'),
  async (req, res, next) => {
    try {
      if (!req.file) return modernError(res, 400, 'file (multipart field "file") is required');
      const out = await zoneUpload.processUpload(req.file.buffer, { dryRun: req.query.dryRun });
      modernOk(res, out);
    } catch (e) { next(e); }
  }
);

module.exports = router;
