const { getDb } = require('../config/database');

const SENSITIVE_KEYS = new Set([
  'password',
  'oldpassword',
  'newpassword',
  'confirmpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'licensetoken'
]);

// AuditAction enum values
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
  // Ledger
  { m: 'POST', u: '/api/v1/ledger/customer/',                 a: 'LEDGER_PAYMENT' },
  { m: 'POST', u: '/api/v1/ledger/adjustment',                a: 'LEDGER_ADJUSTMENT' },
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

const ACTION_SUMMARY_MAP = {
  AUTH_REGISTER: 'Shop registration',
  AUTH_LOGIN: 'User login',
  AUTH_SETUP_COMPLETE: 'Account setup completed',
  AUTH_PASSWORD_RESET: 'Password reset',
  AUTH_LOGOUT: 'User logout',
  AUTH_EMAIL_VERIFY: 'Email verified',
  ITEM_CREATE: 'Inventory item created',
  ITEM_UPDATE: 'Inventory item updated',
  ITEM_DELETE: 'Inventory item deleted',
  CART_CREATE: 'Cart created',
  CART_ITEM_ADD: 'Item added to cart',
  CART_UPDATE: 'Cart updated',
  CART_ITEM_REMOVE: 'Item removed from cart',
  CART_COMPLETE: 'Sale completed',
  CART_CANCEL: 'Cart cancelled',
  EXPRESS_SALE_COMPLETE: 'Express sale completed',
  CUSTOMER_CREATE: 'Customer created',
  CUSTOMER_UPDATE: 'Customer updated',
  CUSTOMER_DELETE: 'Customer deleted',
  VENDOR_CREATE: 'Vendor created',
  VENDOR_UPDATE: 'Vendor updated',
  CATEGORY_CREATE: 'Category created',
  CATEGORY_UPDATE: 'Category updated',
  SHOP_SETTING_UPDATE: 'Shop settings updated',
  USER_PREFERENCE_UPDATE: 'User preferences updated',
  USER_INVITE: 'User invited',
  USER_UPDATE: 'User updated',
  USER_DELETE: 'User deleted',
  USER_PROFILE_UPDATE: 'Profile updated',
  AUTH_PASSWORD_CHANGE: 'Password changed',
  SUBSCRIPTION_ACTIVATE: 'Subscription activated',
  SUBSCRIPTION_REQUEST_CODE: 'Subscription request code generated',
  SUBSCRIPTION_OTP_REQUEST: 'Subscription OTP requested',
  SUBSCRIPTION_UPSERT: 'Subscription updated',
  LEDGER_PAYMENT: 'Customer payment recorded',
  LEDGER_ADJUSTMENT: 'Ledger adjustment recorded',
};

function resolveAction(method, url) {
  const path = url.split('?')[0];
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

function resolveSummary(action) {
  return ACTION_SUMMARY_MAP[action] || action.replace(/_/g, ' ').toLowerCase();
}

function resolveEntityType(url) {
  const path = url.split('?')[0];
  if (path.includes('/item'))         return 'ITEM';
  if (path.includes('/cart'))         return 'CART';
  if (path.includes('/express-sale')) return 'CART';
  if (path.includes('/customer'))     return 'CUSTOMER';
  if (path.includes('/ledger'))       return 'CUSTOMER';
  if (path.includes('/vendor'))       return 'VENDOR';
  if (path.includes('/category'))     return 'CATEGORY';
  if (path.includes('/user'))         return 'USER';
  if (path.includes('/auth'))         return 'AUTH';
  if (path.includes('/subscription')) return 'SUBSCRIPTION';
  if (path.includes('/settings'))     return 'SHOP_SETTING';
  return 'SYSTEM';
}

function resolveStatus(statusCode) {
  return statusCode < 400 ? 'SUCCESS' : 'FAILURE';
}

function sanitizeValue(key, value) {
  if (value === null || value === undefined) return value;

  const keyLower = String(key).toLowerCase();
  if (SENSITIVE_KEYS.has(keyLower)) {
    return '***';
  }

  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      return 'set';
    }
    if (value.length > 500) {
      return value.substring(0, 500) + '...';
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, idx) => sanitizeValue(idx, item));
  }

  if (typeof value === 'object') {
    const obj = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = sanitizeValue(k, v);
    }
    return obj;
  }

  return value;
}

function buildRequestDetails(req) {
  try {
    let payload = req.body;
    if (!payload || Object.keys(payload).length === 0) {
      if (req.query && Object.keys(req.query).length > 0) {
        payload = req.query;
      }
    }

    if (!payload) return null;

    // Handle multipart JSON param strings (e.g. req.body.customer or req.body.item or req.body.user)
    const cloned = { ...payload };
    ['customer', 'item', 'vendor', 'category', 'user'].forEach(param => {
      if (typeof cloned[param] === 'string') {
        try { cloned[param] = JSON.parse(cloned[param]); } catch (_) {}
      }
    });

    const sanitized = sanitizeValue('root', cloned);

    // Format as JSON array matching Spring Boot audit log details format
    const jsonStr = JSON.stringify([sanitized]);
    return jsonStr.length > 4000 ? jsonStr.substring(0, 4000) : jsonStr;
  } catch (err) {
    return null;
  }
}

function auditMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS') return next();

  const originalUrl = req.originalUrl || req.url;
  if (originalUrl.includes('/api/v1/main/validate-token')) return next();

  const requestDetails = buildRequestDetails(req);
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    setImmediate(() => {
      try {
        const db = getDb();
        const user = req.user;
        const status = resolveStatus(res.statusCode);
        const action = resolveAction(req.method, originalUrl);
        const summary = resolveSummary(action);
        const failReason = status === 'FAILURE' ? (body?.failReason || null) : null;

        db.prepare(`
          INSERT INTO audit_log
            (shop_key, actor_user_id, actor_username, action, entity_type, status,
             summary, fail_reason, http_method, request_path, request_details, client_ip, user_agent, created_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
        `).run(
          user?.shop_key || null,
          user?.id || null,
          user?.user_name || null,
          action,
          resolveEntityType(originalUrl),
          status,
          summary,
          failReason,
          req.method,
          originalUrl,
          requestDetails,
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
