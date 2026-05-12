const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');

/*
 * Admin CRUD over client questionnaires.
 *
 * VERIFIED 2026-05-12 against legacy EasyFix_CRM models:
 *   tbl_questionaire (Questionaire.java):
 *     c_questionaire_id (PK), client_id, c_questionaire_name, status,
 *     inserted_by, insert_date, updated_by, update_date
 *
 *   tbl_questionaire_details (QuestionaireDetails.java):
 *     c_qd_id (PK), c_questionaire_id (FK), c_qd_category, c_qd_seq,
 *     c_qd_type, c_qd_sub_type, c_qd_text, c_qd_instn, c_qd_values,
 *     c_qd_mandatory (0/1), c_qd_proof_allowed, c_qd_proof_mandatory,
 *     c_qd_cmnts_allowed, c_qd_cmnts_mandatory, c_qd_weightage,
 *     c_qd_visibility, c_qd_image_doc, c_qd_depends_id,
 *     c_qd_depends_option, c_qd_depends_choice, status, inserted_by,
 *     insert_date
 *
 *   tbl_questionaire_answer (QuestionaireAnswer.java) — answers per job.
 *
 * NOTE: Earlier iteration used WRONG columns (`id`, `q_name`,
 * `questionaire_id`). Bug fixed 2026-05-12 — replaced with the legacy
 * `c_*` naming convention which is canonical across 5 services.
 */

// ─── Questionnaires (header) ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c_questionaire_id, client_id, c_questionaire_name, status,
              inserted_by, insert_date, updated_by, update_date
         FROM tbl_questionaire
        ORDER BY c_questionaire_id DESC
        LIMIT 500`
    );
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT * FROM tbl_questionaire WHERE c_questionaire_id = ?`,
      [req.params.id]
    );
    if (!row) return modernError(res, 404, 'questionnaire not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

const headerBody = Joi.object({
  client_id: Joi.number().integer().positive().required(),
  c_questionaire_name: Joi.string().trim().min(1).max(255).required(),
  status: Joi.number().integer().valid(0, 1).default(1),
});

router.post('/', validate(headerBody), async (req, res, next) => {
  try {
    const [ins] = await pool.query(
      `INSERT INTO tbl_questionaire
         (client_id, c_questionaire_name, status, inserted_by, insert_date)
       VALUES (?, ?, ?, ?, NOW())`,
      [req.body.client_id, req.body.c_questionaire_name, req.body.status, req.user.user_id]
    );
    res.status(201);
    modernOk(res, { c_questionaire_id: ins.insertId }, 'questionnaire created');
  } catch (e) { next(e); }
});

router.patch('/:id', validate(Joi.object({
  c_questionaire_name: Joi.string().trim().min(1).max(255).optional(),
  status: Joi.number().integer().valid(0, 1).optional(),
}).min(1)), async (req, res, next) => {
  try {
    const sets = [], vals = [];
    if (req.body.c_questionaire_name) { sets.push('c_questionaire_name = ?'); vals.push(req.body.c_questionaire_name); }
    if (req.body.status !== undefined) { sets.push('status = ?'); vals.push(req.body.status); }
    sets.push('updated_by = ?', 'update_date = NOW()');
    vals.push(req.user.user_id, req.params.id);
    const [r] = await pool.query(
      `UPDATE tbl_questionaire SET ${sets.join(', ')} WHERE c_questionaire_id = ?`,
      vals
    );
    if (r.affectedRows === 0) return modernError(res, 404, 'questionnaire not found');
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

// ─── Questionnaire detail rows (the actual questions) ───────────────
router.get('/:id/details', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c_qd_id, c_questionaire_id, c_qd_category, c_qd_seq,
              c_qd_type, c_qd_sub_type, c_qd_text, c_qd_instn, c_qd_values,
              c_qd_mandatory, c_qd_proof_allowed, c_qd_proof_mandatory,
              c_qd_cmnts_allowed, c_qd_cmnts_mandatory, c_qd_weightage,
              c_qd_visibility, c_qd_image_doc,
              c_qd_depends_id, c_qd_depends_option, c_qd_depends_choice,
              status
         FROM tbl_questionaire_details
        WHERE c_questionaire_id = ?
        ORDER BY c_qd_seq, c_qd_id`,
      [req.params.id]
    );
    modernOk(res, rows);
  } catch (e) { next(e); }
});

const detailBody = Joi.object({
  c_qd_category: Joi.string().trim().max(100).allow('', null).optional(),
  c_qd_seq: Joi.number().integer().default(0),
  c_qd_type: Joi.string().trim().max(50).required(),
  c_qd_sub_type: Joi.string().trim().max(50).allow('', null).optional(),
  c_qd_text: Joi.string().trim().min(1).max(2000).required(),
  c_qd_instn: Joi.string().trim().max(2000).allow('', null).optional(),
  c_qd_values: Joi.string().trim().max(2000).allow('', null).optional(),
  c_qd_mandatory: Joi.number().integer().valid(0, 1).default(0),
  c_qd_proof_allowed: Joi.number().integer().valid(0, 1).default(0),
  c_qd_proof_mandatory: Joi.number().integer().valid(0, 1).default(0),
  c_qd_cmnts_allowed: Joi.number().integer().valid(0, 1).default(0),
  c_qd_cmnts_mandatory: Joi.number().integer().valid(0, 1).default(0),
  c_qd_weightage: Joi.number().integer().default(0),
  c_qd_visibility: Joi.number().integer().default(1),
  c_qd_image_doc: Joi.string().max(255).allow('', null).optional(),
  c_qd_depends_id: Joi.number().integer().default(0),
  c_qd_depends_option: Joi.number().integer().default(0),
  c_qd_depends_choice: Joi.number().integer().default(0),
  status: Joi.number().integer().valid(0, 1).default(1),
});

router.post('/:id/details', validate(detailBody), async (req, res, next) => {
  try {
    const cols = Object.keys(req.body);
    const placeholders = cols.map(() => '?').join(', ');
    const values = cols.map((k) => req.body[k]);
    const [ins] = await pool.query(
      `INSERT INTO tbl_questionaire_details
         (c_questionaire_id, ${cols.join(', ')}, inserted_by, insert_date)
       VALUES (?, ${placeholders}, ?, NOW())`,
      [req.params.id, ...values, req.user.user_id]
    );
    res.status(201);
    modernOk(res, { c_qd_id: ins.insertId }, 'detail added');
  } catch (e) { next(e); }
});

router.patch('/details/:detailId', async (req, res, next) => {
  try {
    const allowed = Object.keys(detailBody.describe().keys);
    const cols = Object.keys(req.body || {}).filter((k) => allowed.includes(k));
    if (cols.length === 0) return modernError(res, 400, 'no editable fields');
    const sets = cols.map((k) => `${k} = ?`);
    const values = cols.map((k) => req.body[k]);
    const [r] = await pool.query(
      `UPDATE tbl_questionaire_details SET ${sets.join(', ')} WHERE c_qd_id = ?`,
      [...values, req.params.detailId]
    );
    if (r.affectedRows === 0) return modernError(res, 404, 'detail not found');
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.delete('/details/:detailId', async (req, res, next) => {
  try {
    // Soft-delete via status=0 (legacy convention — answers reference these rows).
    const [r] = await pool.query(
      'UPDATE tbl_questionaire_details SET status = 0 WHERE c_qd_id = ?',
      [req.params.detailId]
    );
    if (r.affectedRows === 0) return modernError(res, 404, 'detail not found');
    modernOk(res, { deactivated: true });
  } catch (e) { next(e); }
});

// ─── Answers (read-only — answers come from tech app) ───────────────
router.get('/answers/:jobId', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM tbl_questionaire_answer WHERE job_id = ? ORDER BY id DESC`,
      [req.params.jobId]
    );
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
