require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const logger = require('./logger');
const cors = require('./cors');
const { testConnection, closePool } = require('./db');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/error-handler');
const { rateLimit } = require('./middleware/rate-limit');
const httpLog = require('./middleware/http-log');

const app = express();
const PORT = parseInt(process.env.PORT || '5100', 10);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(httpLog);

app.use(cors);
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Phase 14 — per-tier rate limits. Integration + mobile + client get their own
// bucket; admin is uncapped to avoid self-DoSing a data-entry spree.
app.use('/api/integration', rateLimit({ windowMs: 60_000, max: 1200, key: (req) =>
  req.headers.authorization ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')[0] : req.ip }));
app.use('/api/mobile', rateLimit({ windowMs: 60_000, max: 600 }));
app.use('/api/client', rateLimit({ windowMs: 60_000, max: 600 }));

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

async function start() {
  try {
    await testConnection();
  } catch (err) {
    logger.error(`Could not connect to the database — ${err.message || err.code}. Server will not start.`);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    const env = process.env.NODE_ENV || 'development';
    logger.ready(`Server is ready — listening on http://localhost:${PORT} (${env} mode)`);
    if (process.env.TEST_EMAILS || process.env.TEST_MOBILE) {
      logger.test(`TEST MODE active — outgoing emails redirect to "${process.env.TEST_EMAILS || '—'}", SMS/WhatsApp to "${process.env.TEST_MOBILE || '—'}".`);
    }
    if (String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true') {
      logger.test(`Notifications DISABLED — no real SMS / email / WhatsApp / push will be sent.`);
    }
  });

  const shutdown = async (signal) => {
    logger.shutdown(`Shutdown requested (${signal}) — closing connections gracefully…`);
    server.close(async () => {
      await closePool().catch(() => {});
      logger.shutdown('Server stopped. Goodbye.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = app;
