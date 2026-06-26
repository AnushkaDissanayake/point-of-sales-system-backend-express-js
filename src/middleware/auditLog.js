const { getDb } = require('../config/database');

// AuditAction enum values from Spring Boot — all 43 values
// Mapped by method:originalUrl — longest-prefix match
const ACTION_MAP = [
  // Auth
  { m: 'POST', u: '/api/v1/auth/register',                    a: 'AUTH_REGISTER' },
  { m: 'POST', u: '/api/v1/auth/login',                       a: 'AUTH_LOGIN' },
  { m: 'POST', u: '/api/v1/auth/complete-setup',              a: 'AUTH_SETUP_COMPLETE' },
  { m: 'POST', u: '/api/v1/auth/reset-password',              a: 'AUTH_PASSWORD_RESET' },
  { m: 'POST', u: '/api/v1/auth/logout',                      a: 'AUTH_LOGOUT' },
  { m: 'POST', u: '/api/v1/auth/verify-email',                a: 'AUTH_EMAIL_VERIFY' },
  // Item
  { m: 'POST', u: '/api/v1/item/add-item',                    a: 'ITEM_CREATE' },
  { m: 'POST', u: '/api/v1/item/edit-item',                   a: 'ITEM_UPDATE' },
  { m: 'DELETE', u: '/api/v1/item/',                          a: 'ITEM_DELETE' },
  // Cart
  { m: 'POST', u: '/api/v1/cart/add-cart',                    a: 'CART_CREATE' },
  { m: 'POST', u: '/api/v1/cart/add-cartItem',                a: 'CART_ITEM_ADD' },
  { m: 'PUT',  u: '/api/v1/cart/edit-cart',                   a: 'CART_UPDATE' },
  { m: 'DELETE', u: '/api/v1/cart/item/',                     a: 'CART_ITEM_REMOVE' },
  { m: 'POST', u: '/api/v1/cart/update-cart',                 a: 'CART_UPDATE' },
  { m: 'POST', u: '/api/v1/cart/complete-cart',               a: 'CART_COMPLETE' },
  { m: 'POST', u: '/api/v1/cart/cancel-cart',                 a: 'CART_CANCEL' },
  // Express sale
  { m: 'POST', u: '/api/v1/express-sale/complete',            a: 'EXPRESS_SALE_COMPLETE' },
  // Customer
  { m: 'POST', u: '/api/v1/customer/add-customer',            a: 'CUSTOMER_CREATE' },
  { m: 'POST', u: '/api/v1/customer/edit-customer',           a: 'CUSTOMER_UPDATE' },
  { m: 'DELETE', u: '/api/v1/customer/',                      a: 'CUSTOMER_DELETE' },
  // Vendor
  { m: 'POST', u: '/api/v1/vendor/add-vendor',                a: 'VENDOR_CREATE' },
  { m: 'POST', u: '/api/v1/vendor/edit-vendor',               a: 'VENDOR_UPDATE' },
  // Category
  { m: 'POST', u: '/api/v1/category/add-category',            a: 'CATEGORY_CREATE' },
  { m: 'PUT',  u: '/api/v1/category/edit-category',           a: 'CATEGORY_UPDATE' },
  // Shop settings
  { m: 'PUT',  u: '/api/v1/settings',                         a: 'SHOP_SETTING_UPDATE' },
  // User preferences
  { m: 'PUT',  u: '/api/v1/user/me/preferences',              a: 'USER_PREFERENCE_UPDATE' },
  // User admin
  { m: 'POST', u: '/api/v1/user/invite-user',                 a: 'USER_INVITE' },
  { m: 'POST', u: '/api/v1/user/edit-user',                   a: 'USER_UPDATE' },
  { m: 'DELETE', u: '/api/v1/user/',                          a: 'USER_DELETE' },
  { m: 'POST', u: '/api/v1/user/me/profile',                  a: 'USER_PROFILE_UPDATE' },
  { m: 'POST', u: '/api/v1/user/me/change-password',          a: 'AUTH_PASSWORD_CHANGE' },
  // Subscription
  { m: 'POST', u: '/api/v1/subscription/activate-with-otp',          a: 'SUBSCRIPTION_ACTIVATE' },
  { m: 'POST', u: '/api/v1/subscription/activate-with-license',      a: 'SUBSCRIPTION_ACTIVATE' },
  { m: 'POST', u: '/api/v1/subscription/generate-request-code',      a: 'SUBSCRIPTION_REQUEST_CODE' },
  { m: 'POST', u: '/api/v1/subscription/request-activation-otps',    a: 'SUBSCRIPTION_OTP_REQUEST' },
  { m: 'PUT',  u: '/api/v1/subscription/shops/',                      a: 'SUBSCRIPTION_UPSERT' },
  { m: 'POST', u: '/api/v1/subscription/shops/',                      a: 'SUBSCRIPTION_ACTIVATE' },
];

function resolveAction(method, url) {
  const path = url.split('?')[0];
  // Exact match first, then prefix (longest match wins for prefix routes)
  let best = null;
  let bestLen = 0;
  for (const entry of ACTION_MAP) {
    if (entry.m !== method) continue;
    if (path === entry.u || path.startsWith(entry.u)) {
      if (entry.u.length > bestLen) {
        bestLen = entry.u.length;
        best = entry.a;
      }
    }
  }
  return best || `${method}:${path}`;
}

function resolveEntityType(url) {
  const path = url.split('?')[0];
  if (path.includes('/item'))         return 'ITEM';
  if (path.includes('/cart'))         return 'CART';
  if (path.includes('/express-sale')) return 'CART';
  if (path.includes('/customer'))     return 'CUSTOMER';
  if (path.includes('/vendor'))       return 'VENDOR';
  if (path.includes('/category'))     return 'CATEGORY';
  if (path.includes('/user'))         return 'USER';
  if (path.includes('/auth'))         return 'AUTH';
  if (path.includes('/subscription')) return 'SUBSCRIPTION';
  if (path.includes('/settings'))     return 'SHOP_SETTING';
  return 'SYSTEM';
}

// AuditStatus: SUCCESS or FAILURE (Spring Boot uses FAILURE not FAILED)
function resolveStatus(statusCode) {
  return statusCode < 400 ? 'SUCCESS' : 'FAILURE';
}

function auditMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS') return next();

  const originalUrl = req.originalUrl || req.url;
  if (originalUrl.includes('/api/v1/main/validate-token')) return next();

  const originalJson = res.json.bind(res);

  res.json = function (body) {
    setImmediate(() => {
      try {
        const db = getDb();
        const user = req.user;
        const status = resolveStatus(res.statusCode);
        const action = resolveAction(req.method, originalUrl);
        const failReason = status === 'FAILURE' ? (body?.failReason || null) : null;

        db.prepare(`
          INSERT INTO audit_log
            (shop_key, actor_user_id, actor_username, action, entity_type, status,
             fail_reason, http_method, request_path, client_ip, user_agent, created_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
        `).run(
          user?.shop_key || null,
          user?.id || null,
          user?.user_name || null,
          action,
          resolveEntityType(originalUrl),
          status,
          failReason,
          req.method,
          originalUrl,
          req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
          req.headers['user-agent'] || null
        );
      } catch (err) {
        console.error('Audit log error:', err.message);
      }
    });

    return originalJson(body);
  };

  next();
}

module.exports = { auditMiddleware };
