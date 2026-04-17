const { modernError } = require('../utils/response');

/*
 * Feature flag middleware for legacy/deprecated endpoints that remain ported
 * but disabled. Usage:
 *   router.post('/snapdeal/x', featureFlag('SNAPDEAL'), handler)
 *
 * Env var: <FLAG>_ENABLED. Default: false (disabled = 503).
 */
module.exports = function featureFlag(name) {
  const envKey = `${name.toUpperCase()}_ENABLED`;
  return (req, res, next) => {
    if (String(process.env[envKey] || 'false').toLowerCase() !== 'true') {
      return modernError(res, 503, `feature "${name}" is disabled`, { flag: envKey });
    }
    next();
  };
};
