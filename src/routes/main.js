const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { sendEmail } = require('../utils/email');

function isAppOwner(user) {
  const appOwnerEmail = process.env.APP_OWNER_EMAIL || '';
  return !!(user.email && appOwnerEmail && appOwnerEmail.trim().toLowerCase() === user.email.trim().toLowerCase());
}

const router = express.Router();

const ALL_PERMISSIONS = ['DASHBOARD', 'STORE', 'MANAGE_INVENTORY', 'EXPRESS_SALE', 'CUSTOMER', 'VENDOR', 'CART', 'REPORT', 'SETTINGS'];

function resolvePermissions(user) {
  if (user.role_type === 'ADMIN') return ALL_PERMISSIONS;
  return user.permissions || [];
}

// POST /validate-token — validates JWT and returns full user/license context
router.post('/validate-token', authenticate, (req, res) => {
  try {
    const db = getDb();
    const user = req.user;
    const subscription = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(user.shop_key);
    const now = new Date().toISOString();
    const accessAllowed = subscription?.status === 'ACTIVE' && (!subscription.valid_until || subscription.valid_until > now);

    const detail = db.prepare('SELECT first_name FROM user_detail WHERE user_id = ?').get(user.id);
    // TokenValidationResponseDTO matches Spring Boot exactly
    return successResponse(res, {
      narration: 'Token validated.',
      name: detail?.first_name || user.user_name,
      userType: user.role_type,
      userId: user.id,
      permissions: resolvePermissions(user),
      appOwner: isAppOwner(user),
      subscriptionAccessAllowed: accessAllowed,
      licenseToken: subscription?.license_token || null,
      subscriptionStatus: subscription?.status || 'PENDING',
      shopKey: user.shop_key
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /send-email — ADMIN only — matches Spring Boot MailStructureDTO { email, subject, message, name }
router.post('/send-email', authenticate, requireAdmin, async (req, res) => {
  try {
    const { email, subject, message, name, to, body } = req.body;
    const recipient = email || to;
    const content = message || body;
    if (!recipient || !subject || !content) {
      return errorResponse(res, 400, 'E002', 'email, subject and message are required');
    }
    await sendEmail(recipient, subject, content);
    res.send('mail sent'); // Spring Boot returns plain String "mail sent", not JSON
    return;
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /user-details — stub matching Spring Boot (returns "Token validated.")
router.get('/user-details', authenticate, (req, res) => {
  return successResponse(res, 'Token validated.');
});

// GET /shop-details — stub matching Spring Boot (returns "Token validated.")
router.get('/shop-details', authenticate, (req, res) => {
  return successResponse(res, 'Token validated.');
});

// GET /category-list — lightweight dropdown
router.get('/category-list', authenticate, (req, res) => {
  try {
    const db = getDb();
    const categories = db.prepare(
      'SELECT id, name FROM category WHERE shop_key = ? ORDER BY name'
    ).all(req.user.shop_key);
    // CategoryListResponseDTO { categoryList: [...] } — matches Spring Boot
    return successResponse(res, { categoryList: categories });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /vendor-list — lightweight dropdown
router.get('/vendor-list', authenticate, (req, res) => {
  try {
    const db = getDb();
    const vendors = db.prepare(
      'SELECT id, name FROM vendor WHERE shop_key = ? ORDER BY name'
    ).all(req.user.shop_key);
    // VendorListResponseDTO { vendorList: [...] } — matches Spring Boot
    return successResponse(res, { vendorList: vendors });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
