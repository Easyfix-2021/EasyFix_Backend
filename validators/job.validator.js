const Joi = require('joi');
const { ALL_STATUS_VALUES } = require('../services/job.service');

const intId   = Joi.number().integer().positive();
const mobile  = Joi.string().pattern(/^[0-9]{10}$/);
const pinCode = Joi.string().pattern(/^[0-9]{6}$/);
const gpsPair = Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);

const listQuery = Joi.object({
  q: Joi.string().min(1).max(100).optional(),
  status: Joi.number().integer().valid(...ALL_STATUS_VALUES).optional(),
  clientId: intId.optional(),
  cityId: intId.optional(),
  ownerId: intId.optional(),
  easyfixerId: intId.optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  limit: Joi.number().integer().min(1).max(500).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

const customerBlock = Joi.object({
  customer_id: intId.optional(),
  customer_name: Joi.string().max(255).when('customer_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  customer_mob_no: mobile.when('customer_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  customer_email: Joi.string().email().max(255).optional(),
}).required();

const addressBlock = Joi.object({
  address_id: intId.optional(),
  address: Joi.string().max(2000).when('address_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  building: Joi.string().max(500).optional(),
  landmark: Joi.string().max(500).optional(),
  locality: Joi.string().max(500).optional(),
  city_id: intId.when('address_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  pin_code: pinCode.when('address_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  gps_location: gpsPair.optional(),
  mobile_number: mobile.optional(),
}).required();

const serviceItem = Joi.object({
  service_id: intId.required(),
  quantity: Joi.number().integer().min(1).max(1000).default(1),
  service_type_id: intId.optional(),
  service_category_id: intId.optional(),
});

const createBody = Joi.object({
  job_desc: Joi.string().max(5000).optional(),
  job_type: Joi.string().max(100).default('Installation'),
  source_type: Joi.string().max(50).default('manual'),
  fk_client_id: intId.required(),
  fk_service_type_id: intId.optional(),
  fk_service_catg_id: intId.optional(),
  service_type_ids: Joi.alternatives(Joi.array().items(intId), Joi.string().max(500)).optional(),
  requested_date_time: Joi.date().iso().required(),
  time_slot: Joi.string().max(200).optional(),
  reporting_contact_id: intId.optional(),
  job_owner: intId.optional(),
  client_ref_id: Joi.string().max(100).optional(),
  job_reference_id: Joi.string().max(100).optional(),
  client_spoc: Joi.string().max(200).optional(),
  client_spoc_name: Joi.string().max(200).optional(),
  client_spoc_email: Joi.string().email().max(200).optional(),
  additional_name: Joi.string().max(200).optional(),
  additional_number: mobile.optional(),
  helper_req: Joi.boolean().default(false),
  remarks: Joi.string().max(2000).optional(),
  customer: customerBlock,
  address: addressBlock,
  services: Joi.array().items(serviceItem).optional(),
});

const updateBody = Joi.object({
  job_desc: Joi.string().max(5000).optional(),
  job_type: Joi.string().max(100).optional(),
  source_type: Joi.string().max(50).optional(),
  fk_client_id: intId.optional(),
  fk_service_type_id: intId.optional(),
  fk_service_catg_id: intId.optional(),
  requested_date_time: Joi.date().iso().optional(),
  expected_date_time: Joi.date().iso().optional(),
  time_slot: Joi.string().max(200).optional(),
  reporting_contact_id: intId.optional(),
  job_owner: intId.optional(),
  client_spoc: Joi.string().max(200).optional(),
  client_spoc_name: Joi.string().max(200).optional(),
  client_spoc_email: Joi.string().email().max(200).optional(),
  additional_name: Joi.string().max(200).optional(),
  additional_number: mobile.optional(),
  client_ref_id: Joi.string().max(100).optional(),
  job_reference_id: Joi.string().max(100).optional(),
  helper_req: Joi.boolean().optional(),
  remarks: Joi.string().max(2000).optional(),
  efr_special_notes: Joi.string().max(2000).optional(),
  exp_tat: Joi.string().max(50).optional(),
  booking_cut_off_time: Joi.number().integer().optional(),
  booking_cut_off_time_slot: Joi.string().max(100).optional(),
}).min(1);

const statusBody = Joi.object({
  status: Joi.number().integer().valid(...ALL_STATUS_VALUES).required(),
  reasonId: intId.optional(),
  comment: Joi.string().max(500).optional(),
});

const assignBody = Joi.object({
  easyfixerId: intId.required(),
  reasonId: intId.optional(),
  rescheduleReason: Joi.string().max(500).optional(),
});

const ownerBody = Joi.object({
  newOwnerId: intId.required(),
  reason: Joi.string().min(3).max(500).required(),
});

const idParam = Joi.object({ id: intId.required() });

module.exports = { listQuery, createBody, updateBody, statusBody, assignBody, ownerBody, idParam };
