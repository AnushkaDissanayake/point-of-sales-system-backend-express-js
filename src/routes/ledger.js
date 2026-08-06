const express = require('express');
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { paginatedResponse } = require('../utils/pagination');

const router = express.Router();

// Helper: get customer's current outstanding balance
function getCustomerBalance(db, customerId, shopKey) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END), 0) AS totalDebit,
      COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0) AS totalCredit
    FROM customer_ledger
    WHERE customer_id = ? AND shop_key = ?
  `).get(customerId, shopKey);
  return {
    totalDebit: row.totalDebit,
    totalCredit: row.totalCredit,
    outstandingBalance: Math.round((row.totalDebit - row.totalCredit) * 100) / 100
  };
}

// Helper: get effective credit limit for a customer
function getEffectiveCreditLimit(db, customerId, shopKey) {
  const customer = db.prepare('SELECT credit_limit FROM customer WHERE id = ? AND shop_key = ?').get(customerId, shopKey);
  if (customer && customer.credit_limit !== null && customer.credit_limit !== undefined) {
    return { limit: customer.credit_limit, source: 'CUSTOMER' };
  }
  const setting = db.prepare("SELECT setting_value FROM shop_setting WHERE shop_key = ? AND setting_key = 'DEFAULT_CREDIT_LIMIT'").get(shopKey);
  const defaultLimit = setting ? (parseFloat(setting.setting_value) || 100000) : 100000;
  return { limit: defaultLimit, source: 'SHOP_DEFAULT' };
}

// GET /outstanding - paginated list of customers with outstanding balance > 0
router.get('/outstanding', authenticate, (req, res) => {
  try {
    const { page = 1, size = 20, filterValue = '' } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.max(parseInt(size) || 20, 1);
    const offset = (safePage - 1) * safeSize;
    const db = getDb();

    let whereClause = '';
    const params = [req.user.shop_key];
    const countParams = [req.user.shop_key];
    if (filterValue && filterValue.trim()) {
      whereClause = ' AND (c.name LIKE ? OR c.contact_number LIKE ?)';
      const likeTerm = `%${filterValue.trim()}%`;
      params.push(likeTerm, likeTerm);
      countParams.push(likeTerm, likeTerm);
    }

    const rows = db.prepare(`
      SELECT c.id as customerId, c.name as customerName, c.contact_number as customerContact, c.credit_limit,
        COALESCE(SUM(CASE WHEN l.entry_type = 'DEBIT' THEN l.amount ELSE 0 END), 0) AS totalDebit,
        COALESCE(SUM(CASE WHEN l.entry_type = 'CREDIT' THEN l.amount ELSE 0 END), 0) AS totalCredit,
        MAX(l.created_date) AS lastEntryDate
      FROM customer c
      LEFT JOIN customer_ledger l ON l.customer_id = c.id AND l.shop_key = c.shop_key
      WHERE c.shop_key = ?${whereClause}
      GROUP BY c.id
      HAVING (totalDebit - totalCredit) > 0
      ORDER BY (totalDebit - totalCredit) DESC
      LIMIT ? OFFSET ?
    `).all(...params, safeSize, offset);

    const countRow = db.prepare(`
      SELECT COUNT(*) as total FROM (
        SELECT c.id
        FROM customer c
        LEFT JOIN customer_ledger l ON l.customer_id = c.id AND l.shop_key = c.shop_key
        WHERE c.shop_key = ?${whereClause}
        GROUP BY c.id
        HAVING (COALESCE(SUM(CASE WHEN l.entry_type = 'DEBIT' THEN l.amount ELSE 0 END), 0)
               - COALESCE(SUM(CASE WHEN l.entry_type = 'CREDIT' THEN l.amount ELSE 0 END), 0)) > 0
      )
    `).get(...countParams);

    const shopSetting = db.prepare("SELECT setting_value FROM shop_setting WHERE shop_key = ? AND setting_key = 'DEFAULT_CREDIT_LIMIT'").get(req.user.shop_key);
    const shopDefaultLimit = shopSetting ? (parseFloat(shopSetting.setting_value) || 100000) : 100000;

    const items = rows.map(r => {
      const outstandingBalance = Math.round((r.totalDebit - r.totalCredit) * 100) / 100;
      const effectiveCreditLimit = r.credit_limit !== null && r.credit_limit !== undefined ? r.credit_limit : shopDefaultLimit;
      return {
        customerId: r.customerId,
        customerName: r.customerName,
        customerContact: r.customerContact,
        outstandingBalance,
        effectiveCreditLimit,
        creditLimitSource: (r.credit_limit !== null && r.credit_limit !== undefined) ? 'CUSTOMER' : 'SHOP_DEFAULT',
        lastEntryDate: r.lastEntryDate
      };
    });

    return successResponse(res, { outstanding: paginatedResponse(items, countRow.total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /customer/:customerId/summary
router.get('/customer/:customerId/summary', authenticate, (req, res) => {
  try {
    const db = getDb();
    const { customerId } = req.params;
    const customer = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_key = ?').get(customerId, req.user.shop_key);
    if (!customer) return errorResponse(res, 404, 'E002', 'Customer not found');

    const balance = getCustomerBalance(db, customerId, req.user.shop_key);
    const { limit, source } = getEffectiveCreditLimit(db, customerId, req.user.shop_key);

    return successResponse(res, {
      customerId: customer.id,
      customerName: customer.name,
      customerContact: customer.contact_number,
      totalDebit: balance.totalDebit,
      totalCredit: balance.totalCredit,
      outstandingBalance: balance.outstandingBalance,
      effectiveCreditLimit: limit,
      creditLimitSource: source
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /customer/:customerId/entries - paginated ledger entries with running balance
router.get('/customer/:customerId/entries', authenticate, (req, res) => {
  try {
    const { customerId } = req.params;
    const { page = 1, size = 20 } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.max(parseInt(size) || 20, 1);
    const offset = (safePage - 1) * safeSize;
    const db = getDb();

    const customer = db.prepare('SELECT id FROM customer WHERE id = ? AND shop_key = ?').get(customerId, req.user.shop_key);
    if (!customer) return errorResponse(res, 404, 'E002', 'Customer not found');

    const total = db.prepare('SELECT COUNT(*) as total FROM customer_ledger WHERE customer_id = ? AND shop_key = ?').get(customerId, req.user.shop_key).total;

    // All entries for running balance calculation
    const allEntries = db.prepare(`
      SELECT l.*, u.user_name as created_by_name
      FROM customer_ledger l
      LEFT JOIN usr_user u ON l.created_by = u.id
      WHERE l.customer_id = ? AND l.shop_key = ?
      ORDER BY l.id ASC
    `).all(customerId, req.user.shop_key);

    // Compute running balance for all entries
    let running = 0;
    const allWithBalance = allEntries.map(e => {
      if (e.entry_type === 'DEBIT') running += e.amount;
      else running -= e.amount;
      return { ...e, runningBalance: Math.round(running * 100) / 100 };
    });

    // Paginate (latest first for display)
    const reversed = [...allWithBalance].reverse();
    const paged = reversed.slice(offset, offset + safeSize);

    const items = paged.map(e => ({
      id: e.id,
      entryType: e.entry_type,
      amount: e.amount,
      referenceType: e.reference_type,
      referenceId: e.reference_id,
      notes: e.notes,
      createdDate: e.created_date,
      createdByName: e.created_by_name,
      runningBalance: e.runningBalance
    }));

    return successResponse(res, { entries: paginatedResponse(items, total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /customer/:customerId/payment - record a payment (CREDIT entry)
router.post('/customer/:customerId/payment', authenticate, (req, res) => {
  try {
    const { customerId } = req.params;
    const { amount, notes } = req.body;
    const db = getDb();

    const customer = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_key = ?').get(customerId, req.user.shop_key);
    if (!customer) return errorResponse(res, 404, 'E002', 'Customer not found');

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return errorResponse(res, 400, 'E002', 'Payment amount must be greater than zero');
    }

    const balance = getCustomerBalance(db, customerId, req.user.shop_key);
    if (parsedAmount > balance.outstandingBalance + 0.001) {
      return errorResponse(res, 400, 'E001', `Payment amount (${parsedAmount}) exceeds outstanding balance (${balance.outstandingBalance})`);
    }

    const result = db.prepare(`
      INSERT INTO customer_ledger (customer_id, shop_key, entry_type, amount, reference_type, notes, created_by)
      VALUES (?, ?, 'CREDIT', ?, 'PAYMENT', ?, ?)
    `).run(customerId, req.user.shop_key, parsedAmount, notes || null, req.user.id);

    const newBalance = getCustomerBalance(db, customerId, req.user.shop_key);
    return successResponse(res, {
      id: result.lastInsertRowid,
      entryType: 'CREDIT',
      amount: parsedAmount,
      referenceType: 'PAYMENT',
      notes: notes || null,
      outstandingBalance: newBalance.outstandingBalance
    }, 'Payment recorded successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /adjustment - admin only manual adjustment
router.post('/adjustment', authenticate, (req, res) => {
  try {
    if (req.user.role_type !== 'ADMIN') {
      return errorResponse(res, 403, 'E003', 'Only admins can make manual adjustments');
    }
    const { customerId, entryType, amount, notes } = req.body;
    const db = getDb();

    if (!customerId) return errorResponse(res, 400, 'E002', 'Customer id is required');
    if (!['DEBIT', 'CREDIT'].includes(entryType)) return errorResponse(res, 400, 'E002', 'entryType must be DEBIT or CREDIT');
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return errorResponse(res, 400, 'E002', 'Amount must be greater than zero');

    const customer = db.prepare('SELECT id FROM customer WHERE id = ? AND shop_key = ?').get(customerId, req.user.shop_key);
    if (!customer) return errorResponse(res, 404, 'E002', 'Customer not found');

    const result = db.prepare(`
      INSERT INTO customer_ledger (customer_id, shop_key, entry_type, amount, reference_type, notes, created_by)
      VALUES (?, ?, ?, ?, 'MANUAL', ?, ?)
    `).run(customerId, req.user.shop_key, entryType, parsedAmount, notes || null, req.user.id);

    const newBalance = getCustomerBalance(db, customer.id, req.user.shop_key);
    return successResponse(res, {
      id: result.lastInsertRowid,
      entryType,
      amount: parsedAmount,
      referenceType: 'MANUAL',
      notes: notes || null,
      outstandingBalance: newBalance.outstandingBalance
    }, 'Adjustment recorded successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
module.exports.getCustomerBalance = getCustomerBalance;
module.exports.getEffectiveCreditLimit = getEffectiveCreditLimit;
