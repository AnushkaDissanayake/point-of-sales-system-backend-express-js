const { getDb } = require('../config/database');

function isAppOwner(user) {
  const appOwnerEmail = process.env.APP_OWNER_EMAIL || '';
  return !!(user && user.email && appOwnerEmail && appOwnerEmail.trim().toLowerCase() === user.email.trim().toLowerCase());
}

// Matches Spring Boot SubscriptionEnforcementFilter exactly
// EXEMPT_PREFIXES: /api/v1/auth/*, /api/v1/subscription/public-key (prefix in Spring Boot)
const EXEMPT_PREFIXES = [
  '/api/v1/auth/',
  '/api/v1/subscription/public-key',
];

const EXEMPT_EXACT = new Set([
  '/api/v1/main/validate-token',
  '/api/v1/subscription/my',
  '/api/v1/subscription/license',
  '/api/v1/subscription/activate-with-otp',
  '/api/v1/subscription/activate-with-license',
  '/api/v1/subscription/generate-request-code',
  '/api/v1/subscription/request-activation-otps',
]);

function isExempt(originalUrl) {
  // Strip query string
  const path = originalUrl.split('?')[0];
  if (EXEMPT_EXACT.has(path)) return true;
  return EXEMPT_PREFIXES.some(p => path.startsWith(p));
}

function enforceSubscription(req, res, next) {
  const url = req.originalUrl || req.url;
  if (isExempt(url) || !req.user) return next();

  // App owner bypasses subscription enforcement — matches Spring Boot SubscriptionEnforcementFilter
  if (isAppOwner(req.user)) return next();

  try {
    const db = getDb();
    const sub = db.prepare('SELECT status, valid_until FROM shop_subscription WHERE shop_key = ?').get(req.user.shop_key);

    const now = new Date().toISOString();
    const isActive = sub && sub.status === 'ACTIVE' && (!sub.valid_until || sub.valid_until > now);

    if (!isActive) {
      // Matches Spring Boot ErrorResponseDTO(ErrorCode.SUBSCRIPTION_EXPIRED.getCode(), "Subscription inactive...")
      return res.status(402).json({
        errorCode: 'E004',
        failReason: 'Subscription inactive or expired. Contact the app owner to renew.'
      });
    }

    next();
  } catch (err) {
    console.error('Subscription check error:', err.message);
    next(); // fail open
  }
}

module.exports = { enforceSubscription };
