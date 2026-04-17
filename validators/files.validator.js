const Joi = require('joi');
const { CATEGORIES } = require('../utils/file-storage');

const categoryValues = Object.keys(CATEGORIES);

const uploadForm = Joi.object({
  category: Joi.string().valid(...categoryValues).default('general'),
});

const deleteQuery = Joi.object({
  category: Joi.string().valid(...categoryValues).required(),
  filename: Joi.string().min(1).max(255).required(),
});

module.exports = { uploadForm, deleteQuery };
