const router = require('express').Router();

const validate = require('../middleware/validate');
const requireAuth = require('../middleware/auth');
const { loginOtpRequest, verifyOtpRequest } = require('../validators/auth.validator');
const { createLoginOtp, verifyLoginOtp } = require('../services/auth.service');
const { getRoleById } = require('../services/role.service');
const { signUserToken } = require('../utils/jwt');
const { modernOk, modernError } = require('../utils/response');

/*
 * POST /api/auth/login
 *
 * tbl_user has no password column. Legacy EasyFix_CRM uses Microsoft Azure AD
 * OAuth instead of email+password. Until that path is wired up (or a password
 * column is added intentionally), this endpoint refuses with 501 so clients
 * can clearly route to /login-otp.
 */
router.post('/login', (_req, res) => {
  modernError(
    res,
    501,
    'password login is not supported for internal users; use POST /api/auth/login-otp',
    { alternative: '/api/auth/login-otp' }
  );
});

/*
 * POST /api/auth/login-otp
 * Body: { identifier: email | 10-digit mobile }
 * Always returns 200 to avoid user-enumeration; OTP only issued if user exists.
 */
router.post('/login-otp', validate(loginOtpRequest), async (req, res, next) => {
  try {
    const { identifier } = req.body;
    const result = await createLoginOtp(identifier);
    return modernOk(
      res,
      { delivered: result.found, expiresAt: result.expiresAt ?? null },
      'if the identifier is registered, an OTP has been sent'
    );
  } catch (err) {
    return next(err);
  }
});

/*
 * POST /api/auth/verify-otp
 * Body: { identifier, otp }
 * On success: issues JWT and sets httpOnly cookie.
 */
router.post('/verify-otp', validate(verifyOtpRequest), async (req, res, next) => {
  try {
    const { identifier, otp } = req.body;
    const result = await verifyLoginOtp(identifier, otp);

    if (!result.ok) {
      const map = {
        USER_NOT_FOUND: [401, 'invalid credentials'],
        NO_OTP_ISSUED: [400, 'no active OTP — request one first'],
        OTP_EXPIRED:   [401, 'OTP expired — request a new one'],
        OTP_MISMATCH:  [401, 'incorrect OTP'],
      };
      const [status, message] = map[result.reason] || [401, 'authentication failed'];
      return modernError(res, status, message);
    }

    res.cookie('token', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return modernOk(res, {
      token: result.token,
      user: {
        user_id: result.user.user_id,
        user_name: result.user.user_name,
        official_email: result.user.official_email,
        user_role: result.user.user_role,
        city_id: result.user.city_id,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/*
 * GET /api/auth/me
 * Requires a valid JWT. Returns the fresh tbl_user row + role metadata so the
 * frontend can gate UI without a second request.
 */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const role = await getRoleById(req.user.user_role);
    modernOk(res, {
      user: req.user,
      role: role && {
        role_id: role.role_id,
        role_name: role.role_name,
        group: role.group,
        active: role.role_status,
      },
    });
  } catch (err) {
    next(err);
  }
});

/*
 * POST /api/auth/refresh
 * Issues a new JWT based on the currently valid one. Extends session.
 */
router.post('/refresh', requireAuth, (req, res) => {
  const token = signUserToken(req.user);
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  modernOk(res, { token });
});

/*
 * POST /api/auth/logout
 * Clears the cookie. JWTs themselves stay valid until expiry — stateless by design.
 */
router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  modernOk(res, { loggedOut: true });
});

module.exports = router;
