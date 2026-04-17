const router = require('express').Router();
const multer = require('multer');

const validate = require('../../middleware/validate');
const { writeBuffer, unlinkFile } = require('../../utils/file-storage');
const { modernOk, modernError } = require('../../utils/response');
const { uploadForm, deleteQuery } = require('../../validators/files.validator');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

/*
 * POST /api/shared/upload
 *   multipart/form-data:
 *     file       = <binary, required>
 *     category   = easyfixer_documents | job_files | invoices | general (default)
 *
 * DELETE /api/shared/files?category=...&filename=...
 *   Both query params are required. Filename must not contain "/", "\", or null bytes.
 *   Resolved path must start with the category root (path-traversal guard).
 *
 * Entity-aware deletes that also remove DB rows (e.g. tbl_job_image,
 * tbl_easyfixer_document) live in the owning route groups, NOT here.
 */

router.post('/upload', upload.single('file'), validate(uploadForm, 'body'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'missing "file" upload');

    const result = writeBuffer(
      req.body.category,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );
    modernOk(res, result, 'file uploaded');
  } catch (e) {
    if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.delete('/files', validate(deleteQuery, 'query'), async (req, res, next) => {
  try {
    const result = unlinkFile(req.query.category, req.query.filename);
    modernOk(res, result, 'file deleted');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

module.exports = router;
