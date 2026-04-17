const router = require('express').Router();
const multer = require('multer');

const { parseBuffer } = require('../../utils/excel-parser');
const { bulkUpload } = require('../../services/job-upload.service');
const { modernOk, modernError } = require('../../utils/response');

// In-memory storage: upload parsed immediately, buffer discarded on request end.
// Limit 10 MB (matches legacy SPRING_SERVLET_MULTIPART_MAX_FILE_SIZE=10MB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    // Require the extension to match — a client can fake mimetype but the
    // filename is the clear user-intent signal. Accept .xlsx and .xls.
    if (!/\.xlsx?$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('only .xlsx / .xls files accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

// POST /api/admin/jobs/upload?dryRun=true
// multipart/form-data: file=<xlsx>
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'missing "file" upload');
    const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';

    let parsed;
    try {
      parsed = parseBuffer(req.file.buffer);
    } catch (parseErr) {
      return modernError(res, 400, `could not parse xlsx: ${parseErr.message}`);
    }
    if (parsed.totalRows === 0) {
      return modernError(res, 400, 'xlsx has no data rows (expecting header in row 1, data from row 2)');
    }
    const report = await bulkUpload(parsed, req.user, { dryRun });

    modernOk(res, report, dryRun ? 'validation complete (no rows inserted)' : 'bulk upload complete');
  } catch (e) {
    // Multer / file-size errors have err.code; map to 400
    if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

module.exports = router;
