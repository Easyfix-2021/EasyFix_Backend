const cors = require('cors');

const allowedOrigins = [
  process.env.CRM_URL || 'http://localhost:5180',
  process.env.CLIENT_URL || 'http://localhost:5181',
].filter(Boolean);

module.exports = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
