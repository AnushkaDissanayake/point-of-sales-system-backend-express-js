const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../config/database');
const { generateToken } = require('../utils/jwt');
const { successResponse, errorResponse, setupCredentialsResponse } = require('../utils/response');
const { generateOtp, setEmailOtp, verifyEmailOtp, clearEmailOtp, isOnCooldown, setCooldown } = require('../utils/otp');
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendInvitationEmail,
  sendShopRegistrationToAppOwner,
  sendStaffRegistrationToAdmin
} = require('../utils/email');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function isAppOwner(user) {
  const appOwnerEmail = process.env.APP_OWNER_EMAIL || '';
  return !!(user && user.email && appOwnerEmail && appOwnerEmail.trim().toLowerCase() === user.email.trim().toLowerCase());
}

// Matches Spring Boot RegisterDTO / CompleteSetupDTO / ResetPasswordDTO @Pattern exactly
const PASSWORD_REGEX = /^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#&()\-[\]{}:;',?/*~$^+=<>]).{8,20}$/;

// All FeaturePermission enum names — matches Spring Boot PermissionUtils.resolvePermissionNames() for ADMIN
const ALL_PERMISSIONS = ['DASHBOARD', 'STORE', 'MANAGE_INVENTORY', 'EXPRESS_SALE', 'CUSTOMER', 'VENDOR', 'CART', 'REPORT', 'SETTINGS'];

// Matches Spring Boot PermissionUtils.resolvePermissionNames(user)
function resolvePermissions(db, userId, roleType) {
  if (roleType === 'ADMIN') return ALL_PERMISSIONS;
  return db.prepare('SELECT permission FROM user_permission WHERE user_id = ?')
    .all(userId).map(p => p.permission).sort();
}

// POST /register
router.post('/register', async (req, res) => {
  try {
    const { username, password, email, role, shopId, firstName, lastName } = req.body;

    if (!username || username.length < 3) {
      return errorResponse(res, 400, 'E002', 'Username must be at least 3 characters');
    }
    if (!password || !PASSWORD_REGEX.test(password)) {
      return errorResponse(res, 400, 'E002', 'Password must be 8-20 chars with digit, lowercase, uppercase, and special char');
    }
    if (!email) {
      return errorResponse(res, 400, 'E002', 'Email is required');
    }
    if (!role || !['ADMIN', 'USER'].includes(role.trim().toUpperCase())) {
      return errorResponse(res, 400, 'E001', 'Invalid registration role.');
    }

    const db = getDb();

    // Spring Boot uses findUserEntityByUsernameAndEmailVerified — only verified users block registration
    const existingUser = db.prepare('SELECT id FROM usr_user WHERE user_name = ? AND is_email_verified = 1').get(username);
    if (existingUser) {
      return errorResponse(res, 400, 'E001', 'Username has already been taken');
    }

    // Spring Boot uses findUserEntityByEmailAndVerified — only verified emails block registration
    const existingEmail = db.prepare('SELECT id FROM usr_user WHERE email = ? AND is_email_verified = 1').get(email);
    if (existingEmail) {
      return errorResponse(res, 400, 'E001', 'This email has already been registered');
    }

    const appOwnerEmail = process.env.APP_OWNER_EMAIL || '';
    if (appOwnerEmail && appOwnerEmail.trim().toLowerCase() === email.trim().toLowerCase()) {
      return errorResponse(res, 400, 'E001', 'This email is reserved for the system application owner');
    }

    let shopKey = null;

    if (role === 'ADMIN') {
      // Generate unique 4-digit shop key: 1000–9999, matches Spring Boot
      let key;
      do {
        key = String(1000 + Math.floor(Math.random() * 9000));
      } while (db.prepare('SELECT shop_key FROM shop_detail WHERE shop_key = ?').get(key));

      db.prepare(`INSERT INTO shop_detail (shop_key, shop_name) VALUES (?, ?)`).run(key, (firstName || username) + "'s Shop");
      // createPendingForNewShop — matches Spring Boot (PENDING, not ACTIVE)
      db.prepare(`INSERT INTO shop_subscription (shop_key, status, plan) VALUES (?, 'PENDING', 'MONTHLY')`).run(key);
      shopKey = key;
    } else {
      if (!shopId || !shopId.trim()) {
        return errorResponse(res, 400, 'E002', 'Shop ID is mandatory for user');
      }
      // Spring Boot uses shopId as shopKey string directly (existsByShopKey)
      const shop = db.prepare('SELECT shop_key FROM shop_detail WHERE shop_key = ?').get(shopId.trim());
      if (!shop) {
        return errorResponse(res, 400, 'E001', 'Shop ID is invalid');
      }
      // Require at least one enabled admin for the shop
      const admin = db.prepare("SELECT id FROM usr_user WHERE shop_key = ? AND role_type = 'ADMIN' AND enabled = 1 LIMIT 1").get(shopId.trim());
      if (!admin) {
        return errorResponse(res, 400, 'E001', 'Shop key is invalid');
      }
      shopKey = shop.shop_key;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOtp();
    setEmailOtp(email, otp);

    // enabled=false until email verified — matches Spring Boot (user.setEnabled(false))
    // is_first_time_login=true for all new users — matches Spring Boot
    const result = db.prepare(`
      INSERT INTO usr_user (user_name, password, email, shop_key, role_type, enabled, is_first_time_login, is_email_verified, email_verification_code)
      VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?)
    `).run(username, hashedPassword, email, shopKey, role, otp);

    const userId = result.lastInsertRowid;
    const fullName = `${firstName || ''} ${lastName || ''}`.trim() || username;

    db.prepare(`INSERT INTO user_detail (user_id, first_name, last_name) VALUES (?, ?, ?)`).run(userId, firstName || '', lastName || '');

    // Default USER permission: only DASHBOARD — matches Spring Boot (Set.of(FeaturePermission.DASHBOARD))
    if (role === 'USER') {
      db.prepare('INSERT OR IGNORE INTO user_permission (user_id, permission) VALUES (?, ?)').run(userId, 'DASHBOARD');
    }

    // Send OTP verification email to the registering user
    sendVerificationEmail(email, fullName, otp).catch(console.error);

    // Send notification emails (non-fatal)
    if (role === 'ADMIN') {
      // Notify app owner of new shop registration
      const registeredAt = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
      sendShopRegistrationToAppOwner(shopKey, fullName, email, username, registeredAt).catch(console.error);
    } else {
      // Notify shop admin of new staff registration
      const admin = db.prepare(`
        SELECT u.user_name, u.email, ud.first_name, ud.last_name
        FROM usr_user u
        LEFT JOIN user_detail ud ON u.id = ud.user_id
        WHERE u.shop_key = ? AND u.role_type = 'ADMIN' AND u.enabled = 1
        ORDER BY u.id ASC LIMIT 1
      `).get(shopKey);

      if (admin?.email) {
        const adminName = `${admin.first_name || ''} ${admin.last_name || ''}`.trim() || admin.user_name;
        const registrantSummary = `${fullName} (${email})`;
        sendStaffRegistrationToAdmin(admin.email, adminName, registrantSummary).catch(console.error);
      }
    }

    return successResponse(res, null, 'Registration successful');
  } catch (err) {
    console.error('Register error:', err);
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /verify-email
router.post('/verify-email', (req, res) => {
  try {
    const { email, code, verificationCode } = req.body;
    const otp = code || verificationCode;
    // Spring Boot validates each field separately with different messages
    if (!email || !email.trim()) {
      return errorResponse(res, 400, 'E002', 'Username is mandatory');
    }
    if (!otp || !otp.trim()) {
      return errorResponse(res, 400, 'E002', 'Verification code is mandatory');
    }

    const db = getDb();
    // Spring Boot uses findByEmailAndEmailNotVerified — only look up unverified users
    const user = db.prepare('SELECT * FROM usr_user WHERE email = ? AND is_email_verified = 0').get(email);
    if (!user) return errorResponse(res, 400, 'E001', 'Invalid verification code');

    // Check DB column first (survives server restarts), fall back to in-memory
    const validByDb = user.email_verification_code === otp;
    const result = validByDb ? 'valid' : verifyEmailOtp(email, otp);
    if (result === 'expired') {
      return errorResponse(res, 400, 'E001', 'Verification code expired. Request a new code.');
    }
    if (!validByDb && result !== 'valid' && result !== 'rotated') {
      return errorResponse(res, 400, 'E001', 'Invalid verification code');
    }

    db.prepare('UPDATE usr_user SET is_email_verified = 1, email_verification_code = NULL WHERE email = ?').run(email);
    clearEmailOtp(email);

    return successResponse(res, null, 'Verification successful');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /resend-email-verification
router.post('/resend-email-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.trim()) return errorResponse(res, 400, 'E002', 'Email is required');

    const db = getDb();
    // Only resend to unverified emails — matches Spring Boot findByEmailAndEmailNotVerified
    const user = db.prepare(`
      SELECT u.*, ud.first_name, ud.last_name FROM usr_user u
      LEFT JOIN user_detail ud ON u.id = ud.user_id
      WHERE u.email = ? AND u.is_email_verified = 0
    `).get(email);
    // Spring Boot returns success even when not found — privacy protection
    if (!user) return successResponse(res, null, 'If the account exists, a new code has been sent.');

    const otp = generateOtp();
    setEmailOtp(email, otp);
    setCooldown(email);

    const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.user_name;
    await sendVerificationEmail(email, fullName, otp);

    return successResponse(res, null, 'Verification code sent');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /login
router.post('/login', async (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body;
    if (!usernameOrEmail || !usernameOrEmail.trim()) {
      return errorResponse(res, 400, 'E001', 'Invalid username or password');
    }
    if (!password || !password.trim()) {
      return errorResponse(res, 400, 'E001', 'Invalid username or password');
    }

    const db = getDb();
    // Spring Boot looks up verified users only (findUserEntityByUsernameAndEmailVerified OR findUserEntityByEmailAndVerified)
    let user = db.prepare('SELECT * FROM usr_user WHERE user_name = ? AND is_email_verified = 1').get(usernameOrEmail);
    if (!user) user = db.prepare('SELECT * FROM usr_user WHERE email = ? AND is_email_verified = 1').get(usernameOrEmail);

    if (!user) return errorResponse(res, 400, 'E001', 'Invalid username or password');

    // Reject disabled accounts UNLESS this is a first-time or must-change-password login
    if (!user.enabled && !user.is_first_time_login && !user.must_change_password) {
      return errorResponse(res, 400, 'E001', 'Invalid username or password');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return errorResponse(res, 400, 'E001', 'Invalid username or password');
    }

    // must_change_password: return SETUP_CREDENTIALS without token (matches Spring Boot)
    if (user.must_change_password) {
      return res.json({ status: 'SETUP_CREDENTIALS', message: 'Set your username and password to continue' });
    }

    // is_first_time_login: enable user, clear flag, then proceed to issue token
    if (user.is_first_time_login) {
      db.prepare(`UPDATE usr_user SET enabled = 1, is_first_time_login = 0, verification_code = NULL, last_updated_date = datetime('now') WHERE id = ?`).run(user.id);
    }

    // Spring Boot does NOT revoke existing tokens on login — just saves a new token entity
    const token = generateToken(user.user_name);
    db.prepare('INSERT INTO user_token (user_id, token) VALUES (?, ?)').run(user.id, token);

    const permissions = resolvePermissions(db, user.id, user.role_type);

    const subscription = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(user.shop_key);
    const userDetail = db.prepare('SELECT * FROM user_detail WHERE user_id = ?').get(user.id);

    // Spring Boot AuthResponseDTO: name = firstName only (line 557 in AuthenticationController)
    const firstName = userDetail?.first_name || user.user_name;

    // AuthResponseDTO — flat JSON matching Spring Boot (no data: wrapper)
    return res.json({
      status: 'SUCCESS',
      accessToken: token,
      tokenType: 'Bearer ',
      name: firstName,
      userType: user.role_type,
      userId: user.id,
      permissions,
      subscriptionStatus: subscription?.status || 'PENDING',
      subscriptionAccessAllowed: subscription?.status === 'ACTIVE' && (!subscription.valid_until || subscription.valid_until > new Date().toISOString()),
      appOwner: isAppOwner(user),
      shopKey: user.shop_key,
      licenseToken: subscription?.license_token || null
    });
  } catch (err) {
    console.error('Login error:', err);
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /complete-setup — public endpoint, no JWT required (matches Spring Boot /api/v1/auth/**)
router.post('/complete-setup', async (req, res) => {
  try {
    const { usernameOrEmail, currentPassword, newUsername, newPassword } = req.body;
    if (!usernameOrEmail || !currentPassword || !newUsername || !newPassword) {
      return errorResponse(res, 400, 'E002', 'All fields are required.');
    }

    const errors = {};
    if (newUsername !== undefined && newUsername.trim().length < 3) {
      errors.newUsername = 'Username should contain at least three characters.';
    }
    if (newPassword !== undefined && !PASSWORD_REGEX.test(newPassword)) {
      errors.newPassword = 'Invalid password format.';
    }
    if (Object.keys(errors).length > 0) {
      return res.status(400).json(errors);
    }

    const db = getDb();
    const lookup = usernameOrEmail.trim();
    let user = db.prepare('SELECT * FROM usr_user WHERE user_name = ?').get(lookup);
    if (!user) user = db.prepare('SELECT * FROM usr_user WHERE email = ? AND is_email_verified = 1').get(lookup);
    if (!user) user = db.prepare('SELECT * FROM usr_user WHERE email = ?').get(lookup);

    if (!user || !user.must_change_password) {
      return errorResponse(res, 400, 'E001', 'Invalid setup request.');
    }

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return errorResponse(res, 400, 'E001', 'Invalid temporary password.');

    if (newUsername.trim().length < 3) {
      return errorResponse(res, 400, 'E001', 'Username must be at least 3 characters.');
    }
    const existing = db.prepare('SELECT id FROM usr_user WHERE user_name = ? AND id != ?').get(newUsername.trim(), user.id);
    if (existing) return errorResponse(res, 400, 'E001', 'Username has already been taken');

    // Spring Boot @Pattern validates newPassword against the same regex as registration
    if (!PASSWORD_REGEX.test(newPassword)) {
      return errorResponse(res, 400, 'E001', 'Invalid password format.');
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    db.prepare(`
      UPDATE usr_user SET user_name = ?, password = ?, must_change_password = 0, enabled = 1, last_updated_date = datetime('now') WHERE id = ?
    `).run(newUsername.trim(), hashed, user.id);

    // Revoke old tokens and issue a fresh one
    db.prepare('UPDATE user_token SET revoked = 1, expired = 1 WHERE user_id = ?').run(user.id);
    const token = generateToken(newUsername.trim());
    db.prepare('INSERT INTO user_token (user_id, token) VALUES (?, ?)').run(user.id, token);

    const permissions = resolvePermissions(db, user.id, user.role_type);
    const subscription = db.prepare('SELECT * FROM shop_subscription WHERE shop_key = ?').get(user.shop_key);
    const userDetail = db.prepare('SELECT * FROM user_detail WHERE user_id = ?').get(user.id);
    const firstName = userDetail?.first_name || newUsername.trim();

    // AuthResponseDTO — flat JSON matching Spring Boot (no data: wrapper)
    return res.json({
      status: 'SUCCESS',
      accessToken: token,
      tokenType: 'Bearer ',
      name: firstName,
      userType: user.role_type,
      userId: user.id,
      permissions,
      subscriptionStatus: subscription?.status || 'PENDING',
      subscriptionAccessAllowed: subscription?.status === 'ACTIVE' && (!subscription.valid_until || subscription.valid_until > new Date().toISOString()),
      appOwner: isAppOwner(user),
      shopKey: user.shop_key,
      licenseToken: subscription?.license_token || null
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /username-validation — matches Spring Boot: error if taken, success if available
router.get('/username-validation', (req, res) => {
  const { username } = req.query;
  if (!username) return errorResponse(res, 400, 'E002', 'Username required');
  const db = getDb();
  const exists = db.prepare('SELECT id FROM usr_user WHERE user_name = ? AND is_email_verified = 1').get(username);
  if (exists) return errorResponse(res, 400, 'E003', 'username has already taken');
  return successResponse(res, null, '');
});

// GET /email-validation — matches Spring Boot: error if taken, success if available
router.get('/email-validation', (req, res) => {
  const { email } = req.query;
  if (!email) return errorResponse(res, 400, 'E002', 'Email required');
  const db = getDb();
  const exists = db.prepare('SELECT id FROM usr_user WHERE email = ? AND is_email_verified = 1').get(email);
  if (exists) return errorResponse(res, 400, 'E003', 'email has registered');
  return successResponse(res, null, '');
});

// GET /forget-password
router.get('/forget-password', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return errorResponse(res, 400, 'E002', 'Email required');

    const db = getDb();
    // Spring Boot: findUserEntityByEmailAndVerified — requires verified email
    const user = db.prepare(`
      SELECT u.*, ud.first_name, ud.last_name FROM usr_user u
      LEFT JOIN user_detail ud ON u.id = ud.user_id
      WHERE u.email = ? AND u.is_email_verified = 1
    `).get(email);
    if (!user) return errorResponse(res, 400, 'E001', 'No verified account found for this email');

    if (isOnCooldown('forgot_' + email)) {
      return errorResponse(res, 429, 'E002', 'Please wait 5 minutes before requesting another code');
    }

    // Spring Boot stores OTP in emailVerificationCode (not verification_code)
    const otp = generateOtp();
    db.prepare('UPDATE usr_user SET forgot_password_requested = 1, email_verification_code = ? WHERE email = ?').run(otp, email);

    // Spring Boot passes username (not full name) to passwordReset email template
    await sendPasswordResetEmail(email, user.user_name, otp);

    return successResponse(res, null, 'Verification code sent to your email');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /forget-password-otp — Spring Boot ForgetPasswordDTO uses emailVerificationCode
router.post('/forget-password-otp', (req, res) => {
  try {
    const { email, emailVerificationCode, otp } = req.body;
    const code = emailVerificationCode || otp;
    if (!email || !code) return errorResponse(res, 400, 'E002', 'Email and verification code are required');

    const db = getDb();
    // Spring Boot only checks: verified email + emailVerificationCode match (no forgot_password_requested filter)
    const user = db.prepare(
      'SELECT id FROM usr_user WHERE email = ? AND email_verification_code = ? AND is_email_verified = 1'
    ).get(email.trim(), code.trim());

    if (!user) return errorResponse(res, 400, 'E001', 'Invalid verification code');

    return successResponse(res, null, 'OTP is correct');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, verificationCode, newPassword } = req.body;
    if (!email || !verificationCode || !newPassword) {
      return errorResponse(res, 400, 'E002', 'Email, code and new password required');
    }

    if (!PASSWORD_REGEX.test(newPassword)) {
      return errorResponse(res, 400, 'E002', 'Password does not meet requirements');
    }

    const db = getDb();
    // Spring Boot only checks: verified email + emailVerificationCode match (no forgot_password_requested filter)
    const user = db.prepare(
      'SELECT * FROM usr_user WHERE email = ? AND email_verification_code = ? AND is_email_verified = 1'
    ).get(email.trim(), verificationCode.trim());

    if (!user) return errorResponse(res, 400, 'E001', 'Invalid email or verification code');

    const hashed = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE usr_user SET password = ?, forgot_password_requested = 0, email_verification_code = NULL WHERE id = ?').run(hashed, user.id);

    return successResponse(res, null, 'Password reset successful. Please sign in.');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /logout — revokes current token (matches Spring Boot LogoutService)
router.post('/logout', authenticate, (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE user_token SET expired = 1, revoked = 1 WHERE token = ?').run(req.token);
    return successResponse(res, null, 'Logged out successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
