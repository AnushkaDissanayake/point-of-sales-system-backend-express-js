const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { setSubscriptionOtp, verifySubscriptionOtp, clearSubscriptionOtp, generateOtp, isOnCooldown, setCooldown, hasActiveSubscriptionActivationCodes } = require('../utils/otp');
const { sendSubscriptionRotatedToAppOwner, sendSubscriptionOtpToAppOwner, sendEmail } = require('../utils/email');
const templates = require('../utils/emailTemplates');
require('dotenv').config();

const router = express.Router();

// isAppOwner checks email match — matches Spring Boot SubscriptionService.isAppOwner()
function isAppOwner(user) {
  const appOwnerEmail = process.env.APP_OWNER_EMAIL || 'anushka.dmam@gmail.com';
  return user.email && appOwnerEmail && appOwnerEmail.trim().toLowerCase() === user.email.trim().toLowerCase();
}

function formatSqliteDate(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr !== 'string') return dateStr;
  return dateStr.replace(' ', 'T').replace('Z', '');
}

function getLocalDatetimeString(date = new Date()) {
  const pad = num => String(num).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function buildLicenseResponse(subscription, shopKey) {
  const now = getLocalDatetimeString().replace(' ', 'T');
  const validFrom = formatSqliteDate(subscription?.valid_from);
  const validUntil = formatSqliteDate(subscription?.valid_until);
  const accessAllowed = subscription?.status === 'ACTIVE' && (!validUntil || validUntil > now);
  return {
    shopKey,
    plan: subscription?.plan || 'MONTHLY',
    status: subscription?.status || 'PENDING',
    validFrom,
    validUntil,
    offlineGraceDays: subscription?.offline_grace_days || 7,
    licenseVersion: subscription?.license_version || 0,
    licenseToken: subscription?.license_token,
    notes: subscription?.notes,
    accessAllowed
  };
}

// GET /public-key — returns actual RSA public key PEM, matches Spring Boot SubscriptionLicenseService.getPublicKeyPem()
router.get('/public-key', (req, res) => {
  const pem = loadPublicKey();
  return successResponse(res, { publicKeyPem: pem || 'Public key not configured' });
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
    const now = getLocalDatetimeString().replace(' ', 'T');
    const formattedValidUntil = formatSqliteDate(sub?.valid_until);
    const isActive = sub?.status === 'ACTIVE' && (!formattedValidUntil || formattedValidUntil > now);
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
    if (plan === undefined || plan === null || plan.trim() === '') {
      return res.status(400).json({ plan: 'must not be blank' });
    }

    const normalizedPlan = plan.trim().toUpperCase();
    if (!VALID_PLANS.includes(normalizedPlan)) {
      return errorResponse(res, 400, 'E001', 'Invalid subscription plan');
    }

    const appOwnerEmail = process.env.APP_OWNER_EMAIL || '';
    if (!appOwnerEmail) {
      return res.status(503).json({ errorCode: 'E000', failReason: 'App owner email is not configured on this server.' });
    }

    const planLabel = { MONTHLY:'Monthly', THREE_MONTHS:'3 months', SIX_MONTHS:'6 months', YEARLY:'Yearly', LIFETIME:'Lifetime' }[normalizedPlan] || normalizedPlan;
    const db = getDb();

    // Fetch current subscription to get licenseVersion and offlineGraceDays — matches Spring Boot generateRequestCode()
    const sub = db.prepare('SELECT license_version, offline_grace_days FROM shop_subscription WHERE shop_key = ?').get(req.user.shop_key);
    const licenseVersion = (sub?.license_version ?? 0) + 1;
    const offlineGraceDays = sub?.offline_grace_days ?? 7;

    // Matches Spring Boot SubscriptionLicenseService.generateRequestCode() JSON structure exactly
    const requestCode = Buffer.from(JSON.stringify({
      shopKey: req.user.shop_key,
      plan: normalizedPlan,
      licenseVersion,
      offlineGraceDays,
      machineId: ''
    })).toString('base64');

    const admin = db.prepare(`SELECT user_name, email FROM usr_user WHERE shop_key = ? AND role_type = 'ADMIN' LIMIT 1`).get(req.user.shop_key);
    const requesterSummary = admin ? `${admin.user_name} (${admin.email})` : req.user.shop_key;

    const html = templates.licenseRequestCode(req.user.shop_key, planLabel, requestCode, requesterSummary);
    sendEmail(appOwnerEmail, `License activation request — shop ${req.user.shop_key} (${planLabel})`, html).catch(console.error);

    return successResponse(res, { requestCode }, 'License request sent to the app owner. Wait for the license token and paste it below.');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// Load RSA public key for license token verification (matches Spring Boot SubscriptionLicenseService)
function loadPublicKey() {
  const fs = require('fs');
  const path = require('path');
  const keyFile = path.join(__dirname, '../../data/license-public.key');
  if (!fs.existsSync(keyFile)) return null;
  const b64 = fs.readFileSync(keyFile, 'utf8').trim();
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
}

// POST /activate-with-license
router.post('/activate-with-license', authenticate, (req, res) => {
  try {
    const { licenseToken } = req.body;
    if (!licenseToken || !licenseToken.trim()) return errorResponse(res, 400, 'E002', 'License token is required');

    const publicKeyPem = loadPublicKey();
    if (!publicKeyPem) {
      return res.status(503).json({ errorCode: 'E000', failReason: 'License public key not configured on this server.' });
    }

    // Verify RS256 JWT and extract claims — matches Spring Boot SubscriptionLicenseService.extractClaims()
    const jwt = require('jsonwebtoken');
    let claims;
    try {
      claims = jwt.verify(licenseToken, publicKeyPem, { algorithms: ['RS256'] });
    } catch (e) {
      return errorResponse(res, 400, 'E001', 'Invalid license token');
    }

    // Spring Boot claim keys: sk=shopKey, pl=plan, st=status, vf=validFrom, vu=validUntil, lv=licenseVersion, og=offlineGraceDays
    const shopKey = claims.sk;
    const plan = claims.pl || 'MONTHLY';
    const status = claims.st || 'ACTIVE';
    const validUntil = claims.vu ? getLocalDatetimeString(new Date(claims.vu * 1000)) : null;
    const validFrom = claims.vf ? getLocalDatetimeString(new Date(claims.vf * 1000)) : getLocalDatetimeString();
    const licenseVersion = claims.lv ?? 1;
    const offlineGraceDays = claims.og ?? 7;

    // The token's shopKey must match the authenticated user's shop
    if (shopKey !== req.user.shop_key) {
      return errorResponse(res, 400, 'E001', 'License token is not for this shop');
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO shop_subscription (shop_key, plan, status, valid_from, valid_until, license_token, license_version, offline_grace_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        status = excluded.status, plan = excluded.plan,
        valid_from = excluded.valid_from, valid_until = excluded.valid_until,
        license_token = excluded.license_token, license_version = excluded.license_version,
        offline_grace_days = excluded.offline_grace_days, last_updated_date = datetime('now', 'localtime')
    `).run(req.user.shop_key, plan, status, validFrom, validUntil, licenseToken, licenseVersion, offlineGraceDays);

    const sub = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(req.user.shop_key);
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
    if (activationCode === undefined || activationCode === null || activationCode.trim() === '') {
      return res.status(400).json({ activationCode: 'must not be blank' });
    }
    const code = activationCode || otp;

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
      VALUES (?, ?, 'ACTIVE', datetime('now', 'localtime'), ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        status = 'ACTIVE', plan = excluded.plan, valid_from = datetime('now', 'localtime'),
        valid_until = excluded.valid_until, last_updated_date = datetime('now', 'localtime')
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
  return getLocalDatetimeString(now);
}
const COOLDOWN_MINUTES = 5;

// POST /request-activation-otps — Spring Boot SubscriptionRequestOtpDTO requires plan
router.post('/request-activation-otps', authenticate, requireAdmin, (req, res) => {
  try {
    const { plan } = req.body;
    if (plan === undefined || plan === null || plan.trim() === '') {
      return res.status(400).json({ plan: 'must not be blank' });
    }
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
    const appOwnerEmail = process.env.APP_OWNER_EMAIL || '';
    if (appOwnerEmail) {
      const html = templates.subscriptionActivationOtp(normalizedShopKey, planLabel, otp, 'App owner (subscription management)');
      sendEmail(appOwnerEmail, `Subscription activation code — shop ${normalizedShopKey} (${planLabel})`, html).catch(console.error);
    }

    if (sendToShop) {
      const db = getDb();
      const shopAdmin = db.prepare(`SELECT u.email, ud.first_name FROM usr_user u LEFT JOIN user_detail ud ON u.id = ud.user_id WHERE u.shop_key = ? AND u.role_type = 'ADMIN' AND u.enabled = 1 LIMIT 1`).get(normalizedShopKey);
      if (shopAdmin?.email) {
        const recipientName = shopAdmin.first_name || 'Shop administrator';
        const html = templates.subscriptionActivationOtp(normalizedShopKey, planLabel, otp, recipientName);
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
      SELECT sd.shop_key, ss.plan, ss.status, ss.valid_from, ss.valid_until, ss.offline_grace_days, ss.license_version, ss.notes
      FROM shop_detail sd
      LEFT JOIN shop_subscription ss ON sd.shop_key = ss.shop_key
    `).all();

    const mappedShops = shops.map(row => {
      const now = getLocalDatetimeString().replace(' ', 'T');
      const validFrom = formatSqliteDate(row.valid_from);
      const validUntil = formatSqliteDate(row.valid_until);
      const accessAllowed = row.status === 'ACTIVE' && (!validUntil || validUntil > now);
      return {
        shopKey: row.shop_key,
        plan: row.plan || 'MONTHLY',
        status: row.status || 'PENDING',
        validFrom,
        validUntil,
        offlineGraceDays: row.offline_grace_days || 7,
        licenseVersion: row.license_version || 0,
        notes: row.notes || null,
        accessAllowed
      };
    });

    return successResponse(res, mappedShops);
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
        last_updated_date = datetime('now', 'localtime')
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
      VALUES (?, ?, 'ACTIVE', datetime('now', 'localtime'), ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        plan = excluded.plan, status = 'ACTIVE', valid_from = datetime('now', 'localtime'),
        valid_until = excluded.valid_until, last_updated_date = datetime('now', 'localtime')
    `).run(req.params.shopKey, plan, validUntil);

    const sub = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(req.params.shopKey);
    return successResponse(res, buildLicenseResponse(sub, req.params.shopKey), 'Shop activated');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
