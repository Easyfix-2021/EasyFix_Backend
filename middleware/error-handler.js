const logger = require('../logger');
const { modernError, legacyError } = require('../utils/response');

function isIntegrationRoute(req) {
  return req.originalUrl.startsWith('/api/integration/');
}

function notFound(req, res) {
  if (isIntegrationRoute(req)) {
    return legacyError(res, 404, 'Not Found');
  }
  return modernError(res, 404, 'Not Found');
}

function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;

  logger.error(
    {
      err: { message: err.message, stack: err.stack, code: err.code },
      url: req.originalUrl,
      method: req.method,
    },
    'request error'
  );

  if (isIntegrationRoute(req)) {
    return legacyError(res, status, status >= 500 ? 'Internal Server Error' : err.message);
  }

  const body = {
    success: false,
    error: status >= 500 ? 'Internal Server Error' : err.message,
  };
  if (err.details) body.details = err.details;
  return res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
