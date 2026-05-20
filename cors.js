const cors = require('cors');

// Each *_URL env var may be a single origin OR a comma-separated list.
// Examples:
//   CLIENT_URL=http://localhost:5181
//   CLIENT_URL=http://localhost:5181,http://10.30.2.30:5181,https://corporates.qa.easyfix.in
// Lets one VM serve dev + IP + domain requests without a code change.
function splitOrigins(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const allowedOrigins = [
  ...splitOrigins(process.env.CRM_URL    || 'http://localhost:5180'),
  ...splitOrigins(process.env.CLIENT_URL || 'http://localhost:5181'),
];

module.exports = cors({
  origin(origin, callback) {
    // Same-origin / curl / health probes (no Origin header) are allowed.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
