const jwt = require('jsonwebtoken');

function requireSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is not set');
  return secret;
}

function signUserToken(user) {
  return jwt.sign(
    {
      sub: String(user.user_id),
      email: user.official_email,
      role: user.user_role,
      name: user.user_name,
    },
    requireSecret(),
    { expiresIn: process.env.JWT_EXPIRY || '30d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, requireSecret());
}

module.exports = { signUserToken, verifyToken };
