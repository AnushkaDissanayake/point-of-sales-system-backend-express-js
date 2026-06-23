const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();

const MAX_LOGO_LENGTH = 600000;
// Matches Spring Boot ShopSettingKeys exactly
const SHOP_SETTING_KEYS = {
  EXPRESS_SALE_AUTO_PRINT: 'express_sale.auto_print_receipt',
  EXPRESS_SALE_DEFAULT_PAYMENT_METHOD: 'express_sale.default_payment_method'
};
const VALID_PAYMENT_METHODS = ['CASH', 'CARD', 'ONLINE', 'CHEQUE', 'TRANSFER'];

// GET / — returns structured response matching Spring Boot ShopSettingsResponseDTO
router.get('/', authenticate, (req, res) => {
  try {
    const db = getDb();
    const shop = db.prepare('SELECT * FROM shop_detail WHERE shop_key = ?').get(req.user.shop_key);
    const settings = db.prepare('SELECT setting_key, setting_value FROM shop_setting WHERE shop_key = ?').all(req.user.shop_key);

    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });

    return successResponse(res, {
      status: 'SUCCESS',
      expressSale: {
        // autoPrintReceipt defaults to true — matches Spring Boot buildExpressSaleSettings(values, true)
        autoPrintReceipt: settingsMap[SHOP_SETTING_KEYS.EXPRESS_SALE_AUTO_PRINT] === undefined
          ? true
          : settingsMap[SHOP_SETTING_KEYS.EXPRESS_SALE_AUTO_PRINT] !== 'false',
        defaultPaymentMethod: settingsMap[SHOP_SETTING_KEYS.EXPRESS_SALE_DEFAULT_PAYMENT_METHOD] || 'cash'
      },
      // BusinessProfileDTO includes shopKey for admin — matches Spring Boot buildBusinessProfile(key, isAdmin)
      business: {
        shopName: shop?.shop_name || '',
        shopLogo: shop?.shop_logo || null,
        shopKey: req.user.role_type === 'ADMIN' ? req.user.shop_key : undefined
      }
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// PUT / — accepts structured body matching Spring Boot UpdateShopSettingsRequestDTO
router.put('/', (req, res) => {
  try {
    const db = getDb();
    const { expressSale, business } = req.body;

    // Business profile — ADMIN only; non-admin sending business block gets 403
    if (business && req.user.role_type !== 'ADMIN') {
      return errorResponse(res, 403, 'E001', 'Only admin can update business settings');
    }
    if (business && req.user.role_type === 'ADMIN') {
      const { shopName, shopAddress, shopMobile, shopLogo } = business;

      // shopName required when business block provided — matches Spring Boot
      const name = shopName ? shopName.trim() : '';
      if (!name) return errorResponse(res, 400, 'E001', 'Shop name is required');
      if (name.length > 100) {
        return errorResponse(res, 400, 'E001', 'Shop name is too long');
      }

      if (shopLogo !== undefined && shopLogo !== null && shopLogo !== '') {
        if (!shopLogo.startsWith('data:image/') || !shopLogo.includes('base64,')) {
          return errorResponse(res, 400, 'E001', 'Invalid logo image format');
        }
        if (shopLogo.length > MAX_LOGO_LENGTH) {
          return errorResponse(res, 400, 'E001', 'Logo image is too large');
        }
      }

      db.prepare(`
        UPDATE shop_detail SET
          shop_name = COALESCE(?, shop_name),
          address = COALESCE(?, address),
          mobile = COALESCE(?, mobile),
          shop_logo = COALESCE(?, shop_logo),
          last_updated_date = datetime('now')
        WHERE shop_key = ?
      `).run(
        shopName ?? null,
        shopAddress ?? null,
        shopMobile ?? null,
        shopLogo ?? null,
        req.user.shop_key
      );
    }

    // Express sale settings — any authenticated user
    if (expressSale) {
      const { autoPrintReceipt, defaultPaymentMethod } = expressSale;

      if (autoPrintReceipt !== undefined) {
        upsertSetting(db, req.user.shop_key, SHOP_SETTING_KEYS.EXPRESS_SALE_AUTO_PRINT, String(!!autoPrintReceipt), req.user.id);
      }

      if (defaultPaymentMethod !== undefined) {
        const method = String(defaultPaymentMethod).toUpperCase();
        // PaymentMethodUtil.normalize(): "card" stays "card", everything else → "cash"
        const normalizedMethod = method.toLowerCase() === 'card' ? 'card' : 'cash';
        upsertSetting(db, req.user.shop_key, SHOP_SETTING_KEYS.EXPRESS_SALE_DEFAULT_PAYMENT_METHOD, normalizedMethod, req.user.id);
      }
    }

    return successResponse(res, null, 'Settings saved successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

function upsertSetting(db, shopKey, key, value, userId) {
  db.prepare(`
    INSERT INTO shop_setting (shop_key, setting_key, setting_value, last_updated_by, last_updated_date)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(shop_key, setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      last_updated_by = excluded.last_updated_by,
      last_updated_date = datetime('now')
  `).run(shopKey, key, value, userId);
}

module.exports = router;
