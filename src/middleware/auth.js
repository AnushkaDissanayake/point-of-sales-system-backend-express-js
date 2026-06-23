const { getUsernameFromToken } = require('../utils/jwt');
const { getDb } = require('../config/database');
const { errorResponse } = require('../utils/response');

function authenticate(req, res, next) {
  // SSE endpoints accept token as ?token= query param (matches Spring Boot AuthTokenFilter)
  let token;
  if (req.path && req.originalUrl && req.originalUrl.includes('/events/')) {
    token = req.query.token || null;
  }
  if (!token) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(res, 401, 'E001', 'No token provided');
    }
    token = authHeader.substring(7);
  }

  const username = getUsernameFromToken(token);
  if (!username) {
    return errorResponse(res, 401, 'E001', 'Invalid or expired token');
  }

  const db = getDb();

  const tokenRecord = db.prepare(
    'SELECT session_id FROM user_token WHERE token = ? AND expired = 0 AND revoked = 0'
  ).get(token);

  if (!tokenRecord) {
    return errorResponse(res, 401, 'E001', 'Token revoked or expired');
  }

  const user = db.prepare(
    `SELECT u.id, u.user_name, u.email, u.shop_key, u.role_type, u.enabled,
       u.is_first_time_login, u.must_change_password, u.failed_attempts,
       ud.first_name, ud.last_name, ud.mobile
     FROM usr_user u
     LEFT JOIN user_detail ud ON u.id = ud.user_id
     WHERE u.user_name = ? AND u.enabled = 1`
  ).get(username);

  if (!user) {
    return errorResponse(res, 401, 'E001', 'User not found or disabled');
  }

  const ALL_PERMISSIONS = ['DASHBOARD', 'STORE', 'MANAGE_INVENTORY', 'EXPRESS_SALE', 'CUSTOMER', 'VENDOR', 'CART', 'REPORT', 'SETTINGS'];
  const permissions = user.role_type === 'ADMIN'
    ? ALL_PERMISSIONS
    : db.prepare('SELECT permission FROM user_permission WHERE user_id = ?').all(user.id).map(p => p.permission).sort();

  req.user = { ...user, permissions };
  req.token = token;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role_type !== 'ADMIN') {
    return errorResponse(res, 403, 'E003', 'Admin access required');
  }
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (req.user.role_type === 'ADMIN') return next();
    if (req.user.permissions.includes(permission)) return next();
    return errorResponse(res, 403, 'E003', `Permission required: ${permission}`);
  };
}

module.exports = { authenticate, requireAdmin, requirePermission };
