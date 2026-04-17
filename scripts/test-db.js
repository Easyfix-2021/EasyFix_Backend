#!/usr/bin/env node
require('dotenv').config();

const { testConnection, closePool } = require('../db');
const logger = require('../logger');

(async () => {
  try {
    await testConnection();
    logger.info('✅ database connection OK');
    await closePool();
    process.exit(0);
  } catch (err) {
    logger.error({ code: err.code, msg: err.message }, '❌ database connection failed');
    process.exit(1);
  }
})();
