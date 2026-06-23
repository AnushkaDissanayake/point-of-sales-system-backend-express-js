const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { setSubscriptionOtp, verifySubscriptionOtp, clearSubscriptionOtp, generateOtp, isOnCooldown, setCooldown, hasActiveSubscriptionActivationCodes } = require('../utils/otp');
const { sendSubscriptionRotatedToAppOwner } = require('../utils/email');
const { sendSubscriptionOtpToAppOwner } = require('../utils/email');
require('dotenv').config();

const router = express.Router();

// isAppOwner checks email match — matches Spring Boot SubscriptionService.isAppOwner()
function isAppOwner(user) {
  const appOwnerEmail = process.env.APP_OWNER_EMAIL || 'anushka.dmam@gmail.com';
  return user.email && appOwnerEmail && appOwnerEmail.trim().toLowerCase() === user.email.trim().toLowerCase();
}

function buildLicenseResponse(subscription, shopKey) {
  return {
    shopKey,
    plan: subscription?.plan || 'MONTHLY',
    status: subscription?.status || 'PENDING',
    validFrom: subscription?.valid_from,
    validUntil: subscription?.valid_until,
    offlineGraceDays: subscription?.offline_grace_days || 7,
    licenseVersion: subscription?.license_version || 0,
    licenseToken: subscription?.license_token,
    notes: subscription?.notes
  };
}

// GET /public-key — matches Spring Boot field name "publicKeyPem"
router.get('/public-key', (req, res) => {
  return successResponse(res, { publicKeyPem: 'N/A - SQLite backend uses simple token verification' });
});

// GET /my
router.get('/my', authenticate, (req, res) => {
  try {
    const db = getDb();
    const sub = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(req.user.shop_key);
    return successResponse(res, buildLicenseResponse(sub, req.user.shop_key));
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /license
router.get('/license', authenticate, (req, res) => {
  try {
    const db = getDb();
    const sub = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(req.user.shop_key);
    const now = new Date().toISOString();
    const isActive = sub?.status === 'ACTIVE' && (!sub.valid_until || sub.valid_until > now);
    return successResponse(res, {
      ...buildLicenseResponse(sub, req.user.shop_key),
      accessAllowed: isActive
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /generate-request-code — matches Spring Boot: requires {plan}, emails app owner, returns success message only
router.post('/generate-request-code', authenticate, requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan) return errorResponse(res, 400, 'E002', 'Subscription plan is required');

    const normalizedPlan = plan.trim().toUpperCase();
    if (!VALID_PLANS.includes(normalizedPlan)) {
      return errorResponse(res, 400, 'E001', 'Invalid subscription plan');
    }

    const appOwnerEmail = process.env.APP_OWNER_EMAIL || '';
    if (!appOwnerEmail) {
      return res.status(503).json({ errorCode: 'E000', failReason: 'App owner email is not configured on this server.' });
    }

    const requestCode = Buffer.from(JSON.stringify({
      shopKey: req.user.shop_key,
      plan: normalizedPlan,
      timestamp: new Date().toISOString()
    })).toString('base64');

    const planLabel = { MONTHLY:'Monthly', THREE_MONTHS:'3 months', SIX_MONTHS:'6 months', YEARLY:'Yearly', LIFETIME:'Lifetime' }[normalizedPlan] || normalizedPlan;
    const db = getDb();
    const admin = db.prepare(`SELECT user_name, email FROM usr_user WHERE shop_key = ? AND role_type = 'ADMIN' LIMIT 1`).get(req.user.shop_key);
    const requesterSummary = admin ? `${admin.user_name} (${admin.email})` : req.user.shop_key;

    const { sendEmail } = require('../utils/email');
    const html = `<p>License activation request for shop <b>${req.user.shop_key}</b> (${planLabel}) from ${requesterSummary}.</p><p>Request code: <code>${requestCode}</code></p>`;
    sendEmail(appOwnerEmail, `License activation request — shop ${req.user.shop_key} (${planLabel})`, html).catch(console.error);

    return successResponse(res, null, 'License request sent to the app owner. Wait for the license token and paste it below.');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /activate-with-license
router.post('/activate-with-license', authenticate, (req, res) => {
  try {
    const { licenseToken } = req.body;
    if (!licenseToken) return errorResponse(res, 400, 'E002', 'licenseToken required');

    const db = getDb();

    // Simple license validation - in production this would verify a signed token
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(licenseToken, 'base64').toString());
    } catch {
      return errorResponse(res, 400, 'E002', 'Invalid license token');
    }

    const validUntil = decoded.validUntil || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO shop_subscription (shop_key, plan, status, valid_from, valid_until, license_token, license_version)
      VALUES (?, ?, 'ACTIVE', datetime('now'), ?, ?, 1)
      ON CONFLICT(shop_key) DO UPDATE SET
        status = 'ACTIVE', plan = excluded.plan, valid_from = datetime('now'),
        valid_until = excluded.valid_until, license_token = excluded.license_token,
        license_version = license_version + 1, last_updated_date = datetime('now')
    `).run(req.user.shop_key, decoded.plan || 'MONTHLY', validUntil, licenseToken);

    const sub = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(req.user.shop_key);
    // SubscriptionActivateResponseDTO { message, subscription, license } — matches Spring Boot exactly
    return successResponse(res, {
      message: 'Subscription activated successfully',
      subscription: buildLicenseResponse(sub, req.user.shop_key),
      license: buildLicenseResponse(sub, req.user.shop_key)
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /activate-with-otp — Spring Boot uses activationCode field (SubscriptionActivateOtpDTO)
router.post('/activate-with-otp', authenticate, async (req, res) => {
  try {
    const { activationCode, otp, plan } = req.body;
    const code = activationCode || otp;
    if (!code) return errorResponse(res, 400, 'E002', 'Activation code is required');

    const result = verifySubscriptionOtp(req.user.shop_key, code);

    if (result === 'expired') return errorResponse(res, 400, 'E001', 'Activation code expired. Request a new code for your plan.');
    if (result === 'invalid') {
      if (!hasActiveSubscriptionActivationCodes(req.user.shop_key)) {
        return errorResponse(res, 400, 'E001', 'No active activation code. Select your plan and request a code again.');
      }
      return errorResponse(res, 400, 'E001', 'Invalid activation code');
    }
    if (result.startsWith('rotated:')) {
      // Auto-rotated after 3 failed attempts — format: 'rotated:<newCode>:<plan>'
      const parts = result.split(':');
      const newCode = parts[1];
      const rotatedPlan = parts[2] || 'MONTHLY';
      const db2 = getDb();
      const admin = db2.prepare(`SELECT user_name, email FROM usr_user WHERE shop_key = ? AND role_type = 'ADMIN' LIMIT 1`).get(req.user.shop_key);
      const summary = admin ? `${admin.user_name} (${admin.email})` : req.user.shop_key;
      sendSubscriptionRotatedToAppOwner(req.user.shop_key, rotatedPlan, newCode, summary).catch(console.error);
      return errorResponse(res, 400, 'E001', 'Too many failed attempts. A new code was sent to the app owner — ask them for a fresh code.');
    }

    // result format: 'valid:<plan>' — use the plan from the OTP store (matches Spring Boot verifyResult.plan())
    const storedPlan = result.startsWith('valid:') ? result.split(':')[1] : (plan || 'MONTHLY');
    clearSubscriptionOtp(req.user.shop_key);

    const db = getDb();
    // Plan durations match Spring Boot SubscriptionPlan enum (ChronoUnit.MONTHS)
    const validUntil = computeValidUntil(storedPlan);

    db.prepare(`
      INSERT INTO shop_subscription (shop_key, plan, status, valid_from, valid_until)
      VALUES (?, ?, 'ACTIVE', datetime('now'), ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        status = 'ACTIVE', plan = excluded.plan, valid_from = datetime('now'),
        valid_until = excluded.valid_until, last_updated_date = datetime('now')
    `).run(req.user.shop_key, storedPlan, validUntil);

    const sub = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(req.user.shop_key);
    // SubscriptionActivateResponseDTO { message, subscription, license } — matches Spring Boot exactly
    return successResponse(res, {
      message: 'Subscription activated successfully',
      subscription: buildLicenseResponse(sub, req.user.shop_key),
      license: buildLicenseResponse(sub, req.user.shop_key)
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

const VALID_PLANS = ['MONTHLY', 'THREE_MONTHS', 'SIX_MONTHS', 'YEARLY', 'LIFETIME'];

// Matches Spring Boot SubscriptionPlan enum durations exactly
function computeValidUntil(plan) {
  const now = new Date();
  switch ((plan || 'MONTHLY').toUpperCase()) {
    case 'MONTHLY':      now.setMonth(now.getMonth() + 1);  break;
    case 'THREE_MONTHS': now.setMonth(now.getMonth() + 3);  break;
    case 'SIX_MONTHS':   now.setMonth(now.getMonth() + 6);  break;
    case 'YEARLY':       now.setFullYear(now.getFullYear() + 1); break;
    case 'LIFETIME':     return null; // no expiry
    default:             now.setMonth(now.getMonth() + 1);
  }
  return now.toISOString();
}
const COOLDOWN_MINUTES = 5;

// POST /request-activation-otps — Spring Boot SubscriptionRequestOtpDTO requires plan
router.post('/request-activation-otps', authenticate, requireAdmin, (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan) return errorResponse(res, 400, 'E002', 'Subscription plan is required');
    const normalizedPlan = plan.trim().toUpperCase();
    if (!VALID_PLANS.includes(normalizedPlan)) {
      return errorResponse(res, 400, 'E001', 'Invalid subscription plan');
    }

    if (isOnCooldown('sub_' + req.user.shop_key)) {
      return res.status(429).json({
        errorCode: 'E001',
        failReason: `Please wait ${COOLDOWN_MINUTES} minute(s) before requesting a code again.`
      });
    }

    const otp = generateOtp();
    // Store plan with OTP — matches Spring Boot issueSubscriptionActivationCode(shopKey, plan)
    setSubscriptionOtp(req.user.shop_key, otp, normalizedPlan);
    setCooldown('sub_' + req.user.shop_key);

    const db = getDb();
    const admin = db.prepare(`SELECT u.user_name, u.email FROM usr_user u WHERE u.shop_key = ? AND u.role_type = 'ADMIN' LIMIT 1`).get(req.user.shop_key);
    const requesterSummary = admin ? `${admin.user_name} (${admin.email})` : req.user.shop_key;
    sendSubscriptionOtpToAppOwner(req.user.shop_key, normalizedPlan, otp, requesterSummary).catch(console.error);
    console.log(`[SUBSCRIPTION OTP] Shop: ${req.user.shop_key}, Plan: ${normalizedPlan}, OTP: ${otp}`);

    const planLabel = { MONTHLY:'Monthly', THREE_MONTHS:'3 months', SIX_MONTHS:'6 months', YEARLY:'Yearly', LIFETIME:'Lifetime' }[normalizedPlan] || normalizedPlan.replace(/_/g, ' ');
    return successResponse(res, COOLDOWN_MINUTES, `${planLabel} activation code sent to the app owner. Share Shop ID ${req.user.shop_key} and wait for the code.`);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /shops/:shopKey/issue-activation-otp (App owner only)
// Spring Boot uses @RequestParam for plan and sendToShop — read from query params
router.post('/shops/:shopKey/issue-activation-otp', authenticate, async (req, res) => {
  try {
    if (!isAppOwner(req.user)) return errorResponse(res, 403, 'E001', 'App owner access required');

    const plan = (req.query.plan || req.body.plan || 'MONTHLY').trim().toUpperCase();
    const sendToShop = (req.query.sendToShop || req.body.sendToShop) === 'true';

    if (!VALID_PLANS.includes(plan)) {
      return errorResponse(res, 400, 'E001', 'Invalid subscription plan');
    }

    const normalizedShopKey = req.params.shopKey.trim();
    const otp = generateOtp();
    setSubscriptionOtp(normalizedShopKey, otp, plan);

    const planLabel = { MONTHLY:'Monthly', THREE_MONTHS:'3 months', SIX_MONTHS:'6 months', YEARLY:'Yearly', LIFETIME:'Lifetime' }[plan] || plan;
    const { sendEmail } = require('../utils/email');
    const appOwnerEmail = process.env.APP_OWNER_EMAIL || '';
    if (appOwnerEmail) {
      const html = `<p>Subscription activation code for shop <b>${normalizedShopKey}</b> (${planLabel}).</p><p>Code: <b>${otp}</b></p>`;
      sendEmail(appOwnerEmail, `Subscription activation code — shop ${normalizedShopKey} (${planLabel})`, html).catch(console.error);
    }

    if (sendToShop) {
      const db = getDb();
      const shopAdmin = db.prepare(`SELECT u.email, ud.first_name FROM usr_user u LEFT JOIN user_detail ud ON u.id = ud.user_id WHERE u.shop_key = ? AND u.role_type = 'ADMIN' AND u.enabled = 1 LIMIT 1`).get(normalizedShopKey);
      if (shopAdmin?.email) {
        const html = `<p>Your POS subscription activation code for shop <b>${normalizedShopKey}</b> (${planLabel}): <b>${otp}</b></p>`;
        sendEmail(shopAdmin.email, 'Your POS subscription activation code', html).catch(console.error);
      }
    }

    // Spring Boot returns SuccessResponseDTO with planLabel prefix and no otp/shopKey in response data
    const msg = sendToShop
      ? `${planLabel} activation code emailed to app owner and shop admin.`
      : `${planLabel} activation code emailed to app owner. Share it with the shop if approved.`;
    return successResponse(res, null, msg);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /shops (App owner only)
router.get('/shops', authenticate, (req, res) => {
  try {
    if (!isAppOwner(req.user)) return errorResponse(res, 403, 'E003', 'App owner access required');

    const db = getDb();
    const shops = db.prepare(`
      SELECT sd.*, ss.plan, ss.status as sub_status, ss.valid_from, ss.valid_until
      FROM shop_detail sd
      LEFT JOIN shop_subscription ss ON sd.shop_key = ss.shop_key
    `).all();

    return successResponse(res, shops);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// PUT /shops/:shopKey (App owner only)
router.put('/shops/:shopKey', authenticate, (req, res) => {
  try {
    if (!isAppOwner(req.user)) return errorResponse(res, 403, 'E003', 'App owner access required');

    const { plan, status, validUntil: providedValidUntil, notes } = req.body;
    // Compute validUntil from plan if not explicitly provided (matches Spring Boot upsert logic)
    const validUntil = providedValidUntil || (status === 'ACTIVE' ? computeValidUntil(plan) : null);
    const db = getDb();

    db.prepare(`
      INSERT INTO shop_subscription (shop_key, plan, status, valid_until, notes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        plan = COALESCE(excluded.plan, plan),
        status = COALESCE(excluded.status, status),
        valid_until = COALESCE(excluded.valid_until, valid_until),
        notes = COALESCE(excluded.notes, notes),
        last_updated_date = datetime('now')
    `).run(req.params.shopKey, plan || 'MONTHLY', status || 'ACTIVE', validUntil || null, notes || null);

    const sub = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(req.params.shopKey);
    return successResponse(res, buildLicenseResponse(sub, req.params.shopKey), 'Subscription updated');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /shops/:shopKey/activate (App owner only)
// Spring Boot uses @RequestParam(defaultValue = "MONTHLY") String plan — read from query params
router.post('/shops/:shopKey/activate', authenticate, (req, res) => {
  try {
    if (!isAppOwner(req.user)) return errorResponse(res, 403, 'E001', 'App owner access required');

    const plan = (req.query.plan || req.body.plan || 'MONTHLY').trim().toUpperCase();
    const db = getDb();
    const validUntil = computeValidUntil(plan);

    db.prepare(`
      INSERT INTO shop_subscription (shop_key, plan, status, valid_from, valid_until)
      VALUES (?, ?, 'ACTIVE', datetime('now'), ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        plan = excluded.plan, status = 'ACTIVE', valid_from = datetime('now'),
        valid_until = excluded.valid_until, last_updated_date = datetime('now')
    `).run(req.params.shopKey, plan, validUntil);

    const sub = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(req.params.shopKey);
    return successResponse(res, buildLicenseResponse(sub, req.params.shopKey), 'Shop activated');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
