const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { getDb } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { buildPaginatedQuery, paginatedResponse } = require('../utils/pagination');
const { sendInvitationEmail } = require('../utils/email');
const router = express.Router();
const ALLOWED_COLUMNS = ['id', 'user_name', 'email', 'role_type', 'enabled', 'created_date'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Matches Spring Boot RegisterDTO @Pattern exactly
const PASSWORD_REGEX = /^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#&()\-[\]{}:;',?/*~$^+=<>]).{8,20}$/;
const VALID_PERMISSIONS = ['DASHBOARD', 'STORE', 'MANAGE_INVENTORY', 'EXPRESS_SALE', 'CUSTOMER', 'VENDOR', 'CART', 'REPORT', 'SETTINGS'];

// GET /user-list (ADMIN only)
router.get('/user-list', authenticate, requireAdmin, (req, res) => {
  try {
    // Spring Boot user-list: 1-based page parameter
    const { page = 1, size = 10, sorting, filterColumn, operator, filterValue } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.max(parseInt(size) || 10, 1);
    const db = getDb();
    const shopKey = req.user.shop_key;

    const base = `SELECT u.id, u.user_name, u.email, u.role_type, u.enabled, u.created_date,
      ud.first_name, ud.last_name, ud.mobile
      FROM usr_user u
      LEFT JOIN user_detail ud ON u.id = ud.user_id
      WHERE u.shop_key = ?`;
    const count = `SELECT COUNT(*) as total FROM usr_user u WHERE u.shop_key = ?`;

    const { query, countQuery, params, countParams } = buildPaginatedQuery(
      base, count, [shopKey],
      safePage - 1, safeSize, sorting || 'u.user_name,ASC', filterColumn, operator, filterValue, ALLOWED_COLUMNS
    );

    const rows = db.prepare(query).all(...params);
    const total = db.prepare(countQuery).get(...countParams).total;

    // Map to UserDTO field names matching Spring Boot
    const items = rows.map(u => ({
      id: u.id,
      username: u.user_name,
      email: u.email,
      role: u.role_type,
      enabled: u.enabled === 1,
      firstName: u.first_name,
      lastName: u.last_name,
      mobile: u.mobile
    }));

    // UserListResponseDTO { userList: Page } — number is 0-based (Spring Page.getNumber())
    return successResponse(res, { userList: paginatedResponse(items, total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /:userId/detail (ADMIN only) — matches Spring Boot UserDetailResponseDTO
router.get('/:userId/detail', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT u.id, u.user_name, u.email, u.role_type, u.enabled,
        ud.first_name, ud.last_name, ud.address, ud.nic, ud.mobile
      FROM usr_user u
      LEFT JOIN user_detail ud ON u.id = ud.user_id
      WHERE u.id = ? AND u.shop_key = ?
    `).get(req.params.userId, req.user.shop_key);

    // Spring Boot getShopUser throws 400 "User does not exist." — not 404
    if (!row) return errorResponse(res, 400, 'E001', 'User does not exist.');

    const ALL_PERMISSIONS = ['DASHBOARD', 'STORE', 'MANAGE_INVENTORY', 'EXPRESS_SALE', 'CUSTOMER', 'VENDOR', 'CART', 'REPORT', 'SETTINGS'];
    const permissions = row.role_type === 'ADMIN'
      ? ALL_PERMISSIONS
      : db.prepare('SELECT permission FROM user_permission WHERE user_id = ?').all(req.params.userId).map(p => p.permission).sort();

    // UserDetailResponseDTO wraps UserDTO in { user: {...} } — matches Spring Boot exactly
    return successResponse(res, {
      user: {
        id: row.id,
        username: row.user_name,
        email: row.email,
        role: row.role_type,
        enabled: row.enabled === 1,
        firstName: row.first_name,
        lastName: row.last_name,
        mobile: row.mobile,
        address: row.address,
        nationalIdentity: row.nic,
        permissions
      }
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /edit-user (ADMIN only)
router.post('/edit-user', authenticate, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    // Spring Boot uses @RequestParam("user") String userJson (multipart) — parse JSON param when present
    let body = req.body;
    if (req.body && req.body.user) {
      try { body = JSON.parse(req.body.user); } catch { body = req.body; }
    }
    const { userId, firstName, lastName, mobile, address, nic, enabled, permissions } = body;
    if (!userId) return errorResponse(res, 400, 'E002', 'userId required');

    const db = getDb();
    const user = db.prepare('SELECT * FROM usr_user WHERE id = ? AND shop_key = ?').get(userId, req.user.shop_key);
    if (!user) return errorResponse(res, 400, 'E001', 'User does not exist.');

    // Update user_detail
    let imgSql = '';
    let imgParams = [];
    if (req.file) {
      imgSql = ', image = ?';
      imgParams = [req.file.buffer];
    }

    db.prepare(`
      UPDATE user_detail SET first_name = ?, last_name = ?, mobile = ?, address = ?, nic = ?, last_updated_date = datetime('now') ${imgSql}
      WHERE user_id = ?
    `).run(firstName, lastName, mobile, address, nic, ...imgParams, userId);

    if (enabled !== undefined && user.id !== req.user.id) {
      const enabledVal = enabled === 'true' || enabled === true ? 1 : 0;
      if (!enabledVal) {
        // Cannot disable last admin — matches Spring Boot
        if (user.role_type === 'ADMIN') {
          const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM usr_user WHERE shop_key = ? AND role_type = 'ADMIN' AND enabled = 1").get(req.user.shop_key).cnt;
          if (adminCount <= 1) return errorResponse(res, 400, 'E001', 'Cannot disable the shop admin account.');
        }
        // Revoke all tokens when disabling — matches Spring Boot tokenRepo.deleteByUserEntityUserId()
        db.prepare('DELETE FROM user_token WHERE user_id = ?').run(userId);
      }
      db.prepare('UPDATE usr_user SET enabled = ? WHERE id = ?').run(enabledVal, userId);
    }

    // Spring Boot only updates permissions for non-admin users
    if (permissions && user.role_type !== 'ADMIN') {
      const permsArray = typeof permissions === 'string' ? JSON.parse(permissions) : permissions;
      db.prepare('DELETE FROM user_permission WHERE user_id = ?').run(userId);
      for (const perm of permsArray) {
        if (VALID_PERMISSIONS.includes(perm)) {
          db.prepare('INSERT INTO user_permission (user_id, permission) VALUES (?, ?)').run(userId, perm);
        }
      }
    }

    return successResponse(res, null, 'User updated successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /invite-user (ADMIN only) — matches Spring Boot UserAdminService.inviteUser()
router.post('/invite-user', authenticate, requireAdmin, async (req, res) => {
  try {
    // Spring Boot uses @RequestParam("user") String userJson — parse JSON param when present
    let body = req.body;
    if (req.body && req.body.user) {
      try { body = JSON.parse(req.body.user); } catch { body = req.body; }
    }
    const { email, firstName, lastName, mobile, permissions } = body;
    // firstName required — matches Spring Boot
    if (!email || !email.trim()) return errorResponse(res, 400, 'E002', 'Email is required.');
    if (!firstName || !firstName.trim()) return errorResponse(res, 400, 'E002', 'First name is required.');

    const db = getDb();
    const existing = db.prepare('SELECT id FROM usr_user WHERE email = ?').get(email.trim());
    if (existing) return errorResponse(res, 400, 'E001', 'This email has already been registered');

    // Username generation matching Spring Boot CredentialGenerator
    const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let username;
    let attempts = 0;
    do {
      const suffix = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
      let base = firstName.trim().toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 12);
      if (base.length < 3) base = (email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 12);
      if (base.length < 3) base = 'user';
      username = base + suffix;
      attempts++;
    } while (db.prepare('SELECT id FROM usr_user WHERE user_name = ?').get(username) && attempts < 10);

    if (attempts >= 10 && db.prepare('SELECT id FROM usr_user WHERE user_name = ?').get(username)) {
      return errorResponse(res, 400, 'E000', 'Could not generate a unique username.');
    }

    // Spring Boot CredentialGenerator.generateTemporaryPassword() — uppercase+lowercase+digit+special
    const tempPassword = generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // enabled=false, isFirstTimeLogin=false, mustChangePassword=true, adminCreated=true
    const result = db.prepare(`
      INSERT INTO usr_user (user_name, password, email, shop_key, role_type, enabled, is_email_verified, is_first_time_login, must_change_password, admin_created)
      VALUES (?, ?, ?, ?, 'USER', 0, 1, 0, 1, 1)
    `).run(username, hashedPassword, email.trim(), req.user.shop_key);

    const userId = result.lastInsertRowid;
    db.prepare('INSERT INTO user_detail (user_id, first_name, last_name, mobile) VALUES (?, ?, ?, ?)').run(userId, firstName.trim(), lastName || '', mobile || '');

    const permsArray = permissions ? (typeof permissions === 'string' ? JSON.parse(permissions) : permissions) : [];
    for (const perm of permsArray) {
      if (VALID_PERMISSIONS.includes(perm)) {
        db.prepare('INSERT INTO user_permission (user_id, permission) VALUES (?, ?)').run(userId, perm);
      }
    }

    sendInvitationEmail(email.trim(), firstName.trim(), username, tempPassword).catch(console.error);

    // Returns only success message — matches Spring Boot
    return successResponse(res, null, 'User created and credentials emailed successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

function generateTemporaryPassword() {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '@#$%^&+=!';
  const all = upper + lower + digits + special;
  let pwd = upper[Math.floor(Math.random() * upper.length)]
    + lower[Math.floor(Math.random() * lower.length)]
    + digits[Math.floor(Math.random() * digits.length)]
    + special[Math.floor(Math.random() * special.length)];
  for (let i = 4; i < 10; i++) pwd += all[Math.floor(Math.random() * all.length)];
  return pwd.split('').sort(() => Math.random() - 0.5).join('');
}

// DELETE /:userId (ADMIN only)
router.delete('/:userId', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM usr_user WHERE id = ? AND shop_key = ?').get(req.params.userId, req.user.shop_key);
    if (!user) return errorResponse(res, 400, 'E001', 'User does not exist.');

    // Cannot delete self
    if (user.id === req.user.id) return errorResponse(res, 400, 'E001', 'You cannot delete your own account.');

    // Prevent deleting if this would leave no enabled admins
    if (user.role_type === 'ADMIN') {
      const adminCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM usr_user WHERE shop_key = ? AND role_type = 'ADMIN' AND enabled = 1"
      ).get(req.user.shop_key).cnt;
      if (adminCount <= 1) return errorResponse(res, 400, 'E001', 'Cannot delete the shop admin account.');
    }

    const deleteUser = db.transaction(() => {
      db.prepare('DELETE FROM user_token WHERE user_id = ?').run(req.params.userId);
      db.prepare('DELETE FROM user_permission WHERE user_id = ?').run(req.params.userId);
      db.prepare('DELETE FROM user_setting WHERE user_id = ?').run(req.params.userId);
      db.prepare('DELETE FROM user_detail WHERE user_id = ?').run(req.params.userId);
      // Nullify actor FK in audit logs before deletion — matches Spring Boot auditLogRepo.detachActor()
      db.prepare('UPDATE audit_log SET actor_user_id = NULL WHERE actor_user_id = ?').run(req.params.userId);
      db.prepare('DELETE FROM usr_user WHERE id = ?').run(req.params.userId);
    });
    deleteUser();

    return successResponse(res, null, 'User removed successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /me/profile
router.get('/me/profile', authenticate, (req, res) => {
  try {
    const db = getDb();
    const detail = db.prepare('SELECT * FROM user_detail WHERE user_id = ?').get(req.user.id);

    // Spring Boot getMyProfile returns UserDetailResponseDTO { user: UserDTO }
    return successResponse(res, {
      user: {
        id: req.user.id,
        username: req.user.user_name,
        email: req.user.email,
        role: req.user.role_type,
        enabled: req.user.enabled === 1,
        shopKey: req.user.shop_key,
        permissions: req.user.permissions, // already resolved by middleware (ADMIN gets all)
        firstName: detail?.first_name,
        lastName: detail?.last_name,
        address: detail?.address,
        nationalIdentity: detail?.nic,
        mobile: detail?.mobile
      }
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /me/profile
router.post('/me/profile', authenticate, upload.single('image'), (req, res) => {
  try {
    // Spring Boot uses @RequestParam("user") String userJson — parse JSON param when present
    let body = req.body;
    if (req.body && req.body.user) {
      try { body = JSON.parse(req.body.user); } catch { body = req.body; }
    }
    const { firstName, lastName, mobile, address, nic } = body;
    const db = getDb();

    let imgSql = '';
    let imgParams = [];
    if (req.file) {
      imgSql = ', image = ?';
      imgParams = [req.file.buffer];
    }

    db.prepare(`
      UPDATE user_detail SET first_name = ?, last_name = ?, mobile = ?, address = ?, nic = ?, last_updated_date = datetime('now') ${imgSql}
      WHERE user_id = ?
    `).run(firstName, lastName, mobile, address, nic, ...imgParams, req.user.id);

    return successResponse(res, null, 'Profile updated successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /me/change-password — matches Spring Boot UserAdminService.changeMyPassword()
router.post('/me/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !currentPassword.trim() || !newPassword || !newPassword.trim()) {
      return errorResponse(res, 400, 'E002', 'Current and new password are required.');
    }
    if (newPassword.trim().length < 8) {
      return errorResponse(res, 400, 'E001', 'New password must be at least 8 characters.');
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM usr_user WHERE id = ?').get(req.user.id);

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return errorResponse(res, 400, 'E001', 'Current password is incorrect.');

    // New password must differ — matches Spring Boot
    const sameAsOld = await bcrypt.compare(newPassword.trim(), user.password);
    if (sameAsOld) return errorResponse(res, 400, 'E001', 'New password must be different from the current password.');

    const hashed = await bcrypt.hash(newPassword.trim(), 10);
    db.prepare('UPDATE usr_user SET password = ?, must_change_password = 0 WHERE id = ?').run(hashed, req.user.id);

    return successResponse(res, null, 'Password changed successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /me/image — matches Spring Boot profileImageResponse: returns 204 when no image
router.get('/me/image', authenticate, (req, res) => {
  try {
    const db = getDb();
    const detail = db.prepare('SELECT image FROM user_detail WHERE user_id = ?').get(req.user.id);
    if (!detail?.image) return res.status(204).send();
    res.set('Content-Type', 'image/jpeg');
    return res.send(detail.image);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

const VALID_COLOR_THEMES = ['green', 'ocean', 'sunset', 'violet', 'teal', 'midnight', 'ember'];
const VALID_THEME_MODES = ['light', 'dark'];
const DEFAULT_COLOR_THEME = 'green';
// Matches Spring Boot UserSettingKeys exactly
const KEY_COLOR_THEME = 'appearance.color_theme';
const KEY_THEME_MODE = 'appearance.theme_mode';

// GET /me/preferences — returns structured AppearanceSettingsDTO
router.get('/me/preferences', authenticate, (req, res) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT setting_key, setting_value FROM user_setting WHERE user_id = ?').all(req.user.id);
    const map = {};
    settings.forEach(s => { map[s.setting_key] = s.setting_value; });
    // UserPreferencesDTO { status, colorTheme, themeMode } — matches Spring Boot
    return successResponse(res, {
      status: 'SUCCESS',
      colorTheme: map[KEY_COLOR_THEME] || DEFAULT_COLOR_THEME,
      themeMode: map[KEY_THEME_MODE] || 'light'
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// PUT /me/preferences — accepts UpdateUserPreferencesRequestDTO { colorTheme, themeMode }
router.put('/me/preferences', authenticate, (req, res) => {
  try {
    const { colorTheme, themeMode } = req.body;
    const db = getDb();

    if (colorTheme !== undefined) {
      // Spring Boot normalizes to lowercase before validating
      const normalizedTheme = colorTheme.trim().toLowerCase();
      if (!VALID_COLOR_THEMES.includes(normalizedTheme)) {
        return errorResponse(res, 400, 'E001', 'Invalid color theme');
      }
      upsertUserSetting(db, req.user.id, KEY_COLOR_THEME, normalizedTheme);
    }

    if (themeMode !== undefined) {
      // Spring Boot normalizes to lowercase before validating
      const normalizedMode = themeMode.trim().toLowerCase();
      if (!VALID_THEME_MODES.includes(normalizedMode)) {
        return errorResponse(res, 400, 'E001', 'Invalid theme mode');
      }
      upsertUserSetting(db, req.user.id, KEY_THEME_MODE, normalizedMode);
    }

    // Spring Boot UserPreferencesService.updatePreferences returns SuccessResponseDTO
    return successResponse(res, null, 'Preferences saved successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

function upsertUserSetting(db, userId, key, value) {
  db.prepare(`
    INSERT INTO user_setting (user_id, setting_key, setting_value, last_updated_date)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value, last_updated_date = datetime('now')
  `).run(userId, key, value);
}

// GET /:userId/image (ADMIN only) — matches Spring Boot profileImageResponse: returns 204 when no image
router.get('/:userId/image', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id FROM usr_user WHERE id = ? AND shop_key = ?').get(req.params.userId, req.user.shop_key);
    if (!user) return errorResponse(res, 404, 'E002', 'User not found');

    const detail = db.prepare('SELECT image FROM user_detail WHERE user_id = ?').get(req.params.userId);
    if (!detail?.image) return res.status(204).send();
    res.set('Content-Type', 'image/jpeg');
    return res.send(detail.image);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
