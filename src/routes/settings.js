const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();

const MAX_LOGO_LENGTH = 600000;
// Matches Spring Boot ShopSettingKeys exactly
const SHOP_SETTING_KEYS = {
  EXPRESS_SALE_AUTO_PRINT: 'express_sale.auto_print_receipt',
  EXPRESS_SALE_DEFAULT_PAYMENT_METHOD: 'express_sale.default_payment_method',
  EXPRESS_SALE_ENABLED_PAYMENT_METHODS: 'express_sale.enabled_payment_methods',
  INVENTORY_LOW_STOCK_THRESHOLD: 'inventory.low_stock_threshold',
  PRINT_RECEIPT_PAPER_WIDTH_MM: 'print.receipt_paper_width_mm',
  PRINT_RECEIPT_FOOTER_HTML: 'print.receipt_footer_html'
};
const VALID_PAPER_WIDTHS_MM = [58, 80];
const MAX_RECEIPT_FOOTER_LENGTH = 500;
// Matches frontend src/model/PaymentMethod.tsx PAYMENT_METHODS
const ALL_PAYMENT_METHODS = ['cash', 'card', 'credit', 'transfer'];
const DEFAULT_ENABLED_PAYMENT_METHODS = ['cash', 'card', 'credit'];

// The receipt footer is stored as plain text plus a small fixed set of
// bracket markers ([b]...[/b], [size=large]...[/size], etc.) -- never raw
// HTML. Rendering those markers into actual HTML happens client-side only
// (see receiptFooterMarkup.ts), from a fixed vocabulary the renderer
// itself controls, so there's no HTML-tag-allowlist to maintain here.
// Angle brackets typed into this field are just literal characters in
// this format (no special meaning), safely escaped by the renderer at
// print time -- nothing needs stripping/escaping at storage time.
function sanitizeReceiptFooterMarkup(input) {
  if (typeof input !== 'string') return '';
  return input;
}

// Strips Unicode combining marks and zero-width characters -- these are
// used by "fancy text" generators/keyboards to fake strikethrough/underline
// effects (a base letter + a repeated combining character per letter), and
// have no legitimate reason to be in a shop name. See
// point-of-sales-system-frontend-v2/src/utils/sanitizeDisplayText.ts for
// the matching frontend-side defense (this covers data saved before that
// existed, or via any other client).
const COMBINING_AND_ZERO_WIDTH_CHARS = new RegExp(
  '[\\u0300-\\u036F\\u1AB0-\\u1AFF\\u1DC0-\\u1DFF\\u20D0-\\u20FF' +
    '\\uFE20-\\uFE2F\\u200B-\\u200D\\uFEFF]',
  'g'
);
const sanitizeDisplayText = (value) => value.replace(COMBINING_AND_ZERO_WIDTH_CHARS, '');
const VALID_PAYMENT_METHODS = ['CASH', 'CARD', 'ONLINE', 'CHEQUE', 'TRANSFER'];

// GET / — returns structured response matching Spring Boot ShopSettingsResponseDTO
router.get('/', authenticate, (req, res) => {
  try {
    const db = getDb();
    const shop = db.prepare('SELECT * FROM shop_detail WHERE shop_key = ?').get(req.user.shop_key);
    const settings = db.prepare('SELECT setting_key, setting_value FROM shop_setting WHERE shop_key = ?').all(req.user.shop_key);

    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });

    const thresholdVal = parseFloat(settingsMap[SHOP_SETTING_KEYS.INVENTORY_LOW_STOCK_THRESHOLD]);
    const lowStockThreshold = isNaN(thresholdVal) ? 10 : thresholdVal;

    const os = require('os');
    const serverIps = [];
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          serverIps.push(iface.address);
        }
      }
    }

    return successResponse(res, {
      status: 'SUCCESS',
      serverIps,
      expressSale: {
        // autoPrintReceipt defaults to true — matches Spring Boot buildExpressSaleSettings(values, true)
        autoPrintReceipt: settingsMap[SHOP_SETTING_KEYS.EXPRESS_SALE_AUTO_PRINT] === undefined
          ? true
          : settingsMap[SHOP_SETTING_KEYS.EXPRESS_SALE_AUTO_PRINT] !== 'false',
        defaultPaymentMethod: settingsMap[SHOP_SETTING_KEYS.EXPRESS_SALE_DEFAULT_PAYMENT_METHOD] || 'cash',
        enabledPaymentMethods: (() => {
          const raw = settingsMap[SHOP_SETTING_KEYS.EXPRESS_SALE_ENABLED_PAYMENT_METHODS];
          if (!raw) return DEFAULT_ENABLED_PAYMENT_METHODS;
          const methods = raw.split(',').map(m => m.trim()).filter(m => ALL_PAYMENT_METHODS.includes(m));
          return methods.length ? methods : DEFAULT_ENABLED_PAYMENT_METHODS;
        })()
      },
      // BusinessProfileDTO includes shopKey for admin — matches Spring Boot buildBusinessProfile(key, isAdmin)
      business: {
        shopName: shop?.shop_name || '',
        shopLogo: shop?.shop_logo || null,
        shopAddress: shop?.address || '',
        shopMobile: shop?.mobile || '',
        shopMobile2: shop?.mobile2 || '',
        shopKey: req.user.role_type === 'ADMIN' ? req.user.shop_key : undefined
      },
      inventory: {
        lowStockThreshold
      },
      ledger: {
        defaultCreditLimit: !isNaN(parseFloat(settingsMap['DEFAULT_CREDIT_LIMIT']))
          ? parseFloat(settingsMap['DEFAULT_CREDIT_LIMIT'])
          : 100000
      },
      printing: {
        receiptPaperWidthMm: VALID_PAPER_WIDTHS_MM.includes(parseInt(settingsMap[SHOP_SETTING_KEYS.PRINT_RECEIPT_PAPER_WIDTH_MM], 10))
          ? parseInt(settingsMap[SHOP_SETTING_KEYS.PRINT_RECEIPT_PAPER_WIDTH_MM], 10)
          : 80,
        receiptFooterHtml: settingsMap[SHOP_SETTING_KEYS.PRINT_RECEIPT_FOOTER_HTML] ?? ''
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
    const { expressSale, business, inventory, ledger, printing } = req.body;

    // Business profile — ADMIN only; non-admin sending business block gets 403

    if (business && req.user.role_type !== 'ADMIN') {
      return errorResponse(res, 403, 'E001', 'Only admin can update business settings');
    }
    if (business && req.user.role_type === 'ADMIN') {
      const { shopName, shopAddress, shopMobile, shopMobile2, shopLogo } = business;

      // shopName required when business block provided — matches Spring Boot
      const name = shopName ? sanitizeDisplayText(shopName).trim() : '';
      if (!name) return errorResponse(res, 400, 'E001', 'Shop name is required');
      if (name.length > 100) {
        return errorResponse(res, 400, 'E001', 'Shop name is too long');
      }

      let address = null;
      if (shopAddress !== undefined) {
        address = sanitizeDisplayText(String(shopAddress)).trim();
        if (address.length > 200) {
          return errorResponse(res, 400, 'E001', 'Shop address is too long');
        }
      }

      let mobile = null;
      if (shopMobile !== undefined) {
        mobile = sanitizeDisplayText(String(shopMobile)).trim();
        if (mobile.length > 30) {
          return errorResponse(res, 400, 'E001', 'Phone number is too long');
        }
      }

      let mobile2 = null;
      if (shopMobile2 !== undefined) {
        mobile2 = sanitizeDisplayText(String(shopMobile2)).trim();
        if (mobile2.length > 30) {
          return errorResponse(res, 400, 'E001', 'Second phone number is too long');
        }
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
          mobile2 = COALESCE(?, mobile2),
          shop_logo = COALESCE(?, shop_logo),
          last_updated_date = datetime('now', 'localtime')
        WHERE shop_key = ?
      `).run(
        name || null,
        address,
        mobile,
        mobile2,
        shopLogo ?? null,
        req.user.shop_key
      );
    }

    // Express sale settings — any authenticated user
    if (expressSale) {
      const { autoPrintReceipt, defaultPaymentMethod, enabledPaymentMethods } = expressSale;

      if (autoPrintReceipt !== undefined) {
        upsertSetting(db, req.user.shop_key, SHOP_SETTING_KEYS.EXPRESS_SALE_AUTO_PRINT, String(!!autoPrintReceipt), req.user.id);
      }

      if (enabledPaymentMethods !== undefined) {
        if (!Array.isArray(enabledPaymentMethods) || enabledPaymentMethods.length === 0) {
          return errorResponse(res, 400, 'E001', 'At least one payment method must be enabled');
        }
        const methods = enabledPaymentMethods
          .map(m => String(m).toLowerCase())
          .filter(m => ALL_PAYMENT_METHODS.includes(m));
        if (!methods.length) {
          return errorResponse(res, 400, 'E001', 'At least one payment method must be enabled');
        }
        const deduped = Array.from(new Set(methods));
        upsertSetting(db, req.user.shop_key, SHOP_SETTING_KEYS.EXPRESS_SALE_ENABLED_PAYMENT_METHODS, deduped.join(','), req.user.id);
      }

      if (defaultPaymentMethod !== undefined) {
        const method = String(defaultPaymentMethod).toLowerCase();
        const normalizedMethod = ALL_PAYMENT_METHODS.includes(method) ? method : 'cash';
        upsertSetting(db, req.user.shop_key, SHOP_SETTING_KEYS.EXPRESS_SALE_DEFAULT_PAYMENT_METHOD, normalizedMethod, req.user.id);
      }
    }

    // Inventory settings
    if (inventory) {
      const { lowStockThreshold } = inventory;
      if (lowStockThreshold !== undefined) {
        const threshold = parseFloat(lowStockThreshold);
        if (!isNaN(threshold)) {
          upsertSetting(db, req.user.shop_key, SHOP_SETTING_KEYS.INVENTORY_LOW_STOCK_THRESHOLD, String(threshold), req.user.id);
        }
      }
    }

    // Ledger settings
    if (ledger) {
      const { defaultCreditLimit } = ledger;
      if (defaultCreditLimit !== undefined) {
        const limit = parseFloat(defaultCreditLimit);
        if (!isNaN(limit) && limit >= 0) {
          upsertSetting(db, req.user.shop_key, 'DEFAULT_CREDIT_LIMIT', String(limit), req.user.id);
        }
      }
    }

    // Printing settings — any authenticated user (per-register hardware setting)
    if (printing) {
      const { receiptPaperWidthMm, receiptFooterHtml } = printing;
      if (receiptPaperWidthMm !== undefined) {
        const width = parseInt(receiptPaperWidthMm, 10);
        if (!VALID_PAPER_WIDTHS_MM.includes(width)) {
          return errorResponse(res, 400, 'E001', `receiptPaperWidthMm must be one of: ${VALID_PAPER_WIDTHS_MM.join(', ')}`);
        }
        upsertSetting(db, req.user.shop_key, SHOP_SETTING_KEYS.PRINT_RECEIPT_PAPER_WIDTH_MM, String(width), req.user.id);
      }

      if (receiptFooterHtml !== undefined) {
        if (typeof receiptFooterHtml !== 'string' || receiptFooterHtml.length > MAX_RECEIPT_FOOTER_LENGTH) {
          return errorResponse(res, 400, 'E001', `receiptFooterHtml must be a string up to ${MAX_RECEIPT_FOOTER_LENGTH} characters`);
        }
        const safeFooter = sanitizeDisplayText(sanitizeReceiptFooterMarkup(receiptFooterHtml));
        upsertSetting(db, req.user.shop_key, SHOP_SETTING_KEYS.PRINT_RECEIPT_FOOTER_HTML, safeFooter, req.user.id);
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
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(shop_key, setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      last_updated_by = excluded.last_updated_by,
      last_updated_date = datetime('now', 'localtime')
  `).run(shopKey, key, value, userId);
}

module.exports = router;
