const express = require('express');
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { paginatedResponse } = require('../utils/pagination');

const router = express.Router();

function getVendorBalance(db, vendorId, shopKey) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END), 0)  AS totalDebit,
      COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0) AS totalCredit
    FROM vendor_ledger
    WHERE vendor_id = ? AND shop_key = ?
  `).get(vendorId, shopKey);
  return {
    totalDebit: row.totalDebit,
    totalCredit: row.totalCredit,
    outstandingBalance: Math.round((row.totalDebit - row.totalCredit) * 100) / 100
  };
}

// GET /api/v1/vendor-ledger/outstanding
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
      whereClause = ' AND (v.name LIKE ? OR v.contact_number LIKE ?)';
      const likeTerm = `%${filterValue.trim()}%`;
      params.push(likeTerm, likeTerm);
      countParams.push(likeTerm, likeTerm);
    }

    const rows = db.prepare(`
      SELECT v.id as vendorId, v.name as vendorName, v.contact_number as vendorContact,
        COALESCE(SUM(CASE WHEN l.entry_type = 'DEBIT' THEN l.amount ELSE 0 END), 0)  AS totalDebit,
        COALESCE(SUM(CASE WHEN l.entry_type = 'CREDIT' THEN l.amount ELSE 0 END), 0) AS totalCredit,
        MAX(l.created_date) AS lastEntryDate,
        MIN(CASE WHEN l.entry_type = 'DEBIT' AND l.due_date IS NOT NULL THEN l.due_date ELSE NULL END) AS nearestDueDate
      FROM vendor v
      LEFT JOIN vendor_ledger l ON l.vendor_id = v.id AND l.shop_key = v.shop_key
      WHERE v.shop_key = ?${whereClause}
      GROUP BY v.id
      HAVING (totalDebit - totalCredit) > 0
      ORDER BY (totalDebit - totalCredit) DESC
      LIMIT ? OFFSET ?
    `).all(...params, safeSize, offset);

    const countRow = db.prepare(`
      SELECT COUNT(*) as total FROM (
        SELECT v.id
        FROM vendor v
        LEFT JOIN vendor_ledger l ON l.vendor_id = v.id AND l.shop_key = v.shop_key
        WHERE v.shop_key = ?${whereClause}
        GROUP BY v.id
        HAVING (COALESCE(SUM(CASE WHEN l.entry_type = 'DEBIT' THEN l.amount ELSE 0 END), 0)
               - COALESCE(SUM(CASE WHEN l.entry_type = 'CREDIT' THEN l.amount ELSE 0 END), 0)) > 0
      )
    `).get(...countParams);

    const items = rows.map(r => ({
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      vendorContact: r.vendorContact,
      outstandingBalance: Math.round((r.totalDebit - r.totalCredit) * 100) / 100,
      lastEntryDate: r.lastEntryDate,
      nearestDueDate: r.nearestDueDate || null
    }));

    return successResponse(res, { outstanding: paginatedResponse(items, countRow.total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /api/v1/vendor-ledger/vendor/:vendorId/summary
router.get('/vendor/:vendorId/summary', authenticate, (req, res) => {
  try {
    const db = getDb();
    const { vendorId } = req.params;
    const vendor = db.prepare('SELECT * FROM vendor WHERE id = ? AND shop_key = ?').get(vendorId, req.user.shop_key);
    if (!vendor) return errorResponse(res, 404, 'E002', 'Vendor not found');

    const balance = getVendorBalance(db, vendorId, req.user.shop_key);

    return successResponse(res, {
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorContact: vendor.contact_number,
      totalDebit: balance.totalDebit,
      totalCredit: balance.totalCredit,
      outstandingBalance: balance.outstandingBalance
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /api/v1/vendor-ledger/vendor/:vendorId/entries
router.get('/vendor/:vendorId/entries', authenticate, (req, res) => {
  try {
    const { vendorId } = req.params;
    const { page = 1, size = 20 } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.max(parseInt(size) || 20, 1);
    const offset = (safePage - 1) * safeSize;
    const db = getDb();

    const vendor = db.prepare('SELECT id FROM vendor WHERE id = ? AND shop_key = ?').get(vendorId, req.user.shop_key);
    if (!vendor) return errorResponse(res, 404, 'E002', 'Vendor not found');

    const total = db.prepare('SELECT COUNT(*) as total FROM vendor_ledger WHERE vendor_id = ? AND shop_key = ?').get(vendorId, req.user.shop_key).total;

    const allEntries = db.prepare(`
      SELECT l.*, u.user_name as created_by_name
      FROM vendor_ledger l
      LEFT JOIN usr_user u ON l.created_by = u.id
      WHERE l.vendor_id = ? AND l.shop_key = ?
      ORDER BY l.id ASC
    `).all(vendorId, req.user.shop_key);

    let running = 0;
    const allWithBalance = allEntries.map(e => {
      if (e.entry_type === 'DEBIT') running += e.amount;
      else running -= e.amount;
      return { ...e, runningBalance: Math.round(running * 100) / 100 };
    });

    const reversed = [...allWithBalance].reverse();
    const paged = reversed.slice(offset, offset + safeSize);

    const items = paged.map(e => ({
      id: e.id,
      entryType: e.entry_type,
      amount: e.amount,
      referenceType: e.reference_type,
      referenceId: e.reference_id,
      notes: e.notes,
      dueDate: e.due_date || null,
      createdDate: e.created_date,
      createdByName: e.created_by_name,
      runningBalance: e.runningBalance
    }));

    return successResponse(res, { entries: paginatedResponse(items, total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /api/v1/vendor-ledger/vendor/:vendorId/credit-purchase
router.post('/vendor/:vendorId/credit-purchase', authenticate, (req, res) => {
  try {
    const { vendorId } = req.params;
    const { amount, notes, dueDate } = req.body;
    const db = getDb();

    const vendor = db.prepare('SELECT * FROM vendor WHERE id = ? AND shop_key = ?').get(vendorId, req.user.shop_key);
    if (!vendor) return errorResponse(res, 404, 'E002', 'Vendor not found');

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return errorResponse(res, 400, 'E002', 'Amount must be greater than zero');
    }

    const result = db.prepare(`
      INSERT INTO vendor_ledger (vendor_id, shop_key, entry_type, amount, reference_type, notes, due_date, created_by)
      VALUES (?, ?, 'DEBIT', ?, 'CREDIT_PURCHASE', ?, ?, ?)
    `).run(vendorId, req.user.shop_key, parsedAmount, notes || null, dueDate || null, req.user.id);

    const newBalance = getVendorBalance(db, vendorId, req.user.shop_key);
    return successResponse(res, {
      id: result.lastInsertRowid,
      entryType: 'DEBIT',
      amount: parsedAmount,
      referenceType: 'CREDIT_PURCHASE',
      notes: notes || null,
      dueDate: dueDate || null,
      outstandingBalance: newBalance.outstandingBalance
    }, 'Credit purchase recorded successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /api/v1/vendor-ledger/vendor/:vendorId/payment
router.post('/vendor/:vendorId/payment', authenticate, (req, res) => {
  try {
    const { vendorId } = req.params;
    const { amount, notes } = req.body;
    const db = getDb();

    const vendor = db.prepare('SELECT * FROM vendor WHERE id = ? AND shop_key = ?').get(vendorId, req.user.shop_key);
    if (!vendor) return errorResponse(res, 404, 'E002', 'Vendor not found');

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return errorResponse(res, 400, 'E002', 'Payment amount must be greater than zero');
    }

    const balance = getVendorBalance(db, vendorId, req.user.shop_key);
    if (parsedAmount > balance.outstandingBalance + 0.001) {
      return errorResponse(res, 400, 'E001', `Payment amount (${parsedAmount}) exceeds outstanding balance (${balance.outstandingBalance})`);
    }

    const result = db.prepare(`
      INSERT INTO vendor_ledger (vendor_id, shop_key, entry_type, amount, reference_type, notes, created_by)
      VALUES (?, ?, 'CREDIT', ?, 'PAYMENT', ?, ?)
    `).run(vendorId, req.user.shop_key, parsedAmount, notes || null, req.user.id);

    const newBalance = getVendorBalance(db, vendorId, req.user.shop_key);
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

// POST /api/v1/vendor-ledger/adjustment (admin only)
router.post('/adjustment', authenticate, (req, res) => {
  try {
    if (req.user.role_type !== 'ADMIN') {
      return errorResponse(res, 403, 'E003', 'Only admins can make manual adjustments');
    }
    const { vendorId, entryType, amount, notes, dueDate } = req.body;
    const db = getDb();

    if (!vendorId) return errorResponse(res, 400, 'E002', 'Vendor id is required');
    if (!['DEBIT', 'CREDIT'].includes(entryType)) return errorResponse(res, 400, 'E002', 'entryType must be DEBIT or CREDIT');
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return errorResponse(res, 400, 'E002', 'Amount must be greater than zero');

    const vendor = db.prepare('SELECT id FROM vendor WHERE id = ? AND shop_key = ?').get(vendorId, req.user.shop_key);
    if (!vendor) return errorResponse(res, 404, 'E002', 'Vendor not found');

    const result = db.prepare(`
      INSERT INTO vendor_ledger (vendor_id, shop_key, entry_type, amount, reference_type, notes, due_date, created_by)
      VALUES (?, ?, ?, ?, 'MANUAL', ?, ?, ?)
    `).run(vendorId, req.user.shop_key, entryType, parsedAmount, notes || null, dueDate || null, req.user.id);

    const newBalance = getVendorBalance(db, vendorId, req.user.shop_key);
    return successResponse(res, {
      id: result.lastInsertRowid,
      entryType,
      amount: parsedAmount,
      referenceType: 'MANUAL',
      notes: notes || null,
      dueDate: dueDate || null,
      outstandingBalance: newBalance.outstandingBalance
    }, 'Adjustment recorded successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
module.exports.getVendorBalance = getVendorBalance;
