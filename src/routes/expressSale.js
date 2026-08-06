const express = require('express');
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { createLowStockNotification, createSaleNotification, getLowStockThreshold } = require('../services/notificationService');
const { broadcast } = require('./events');
const { getCustomerBalance, getEffectiveCreditLimit } = require('./ledger');

const router = express.Router();
const VALID_PAYMENT_METHODS = ['CASH', 'CARD', 'ONLINE', 'CHEQUE', 'TRANSFER', 'CREDIT'];

router.post('/complete', authenticate, (req, res) => {
  try {
    const { customerName, customerContact, notes, amountPaid, paymentMethod, lines } = req.body;

    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return errorResponse(res, 400, 'E002', 'Cart is empty');
    }

    // Validate all lines before touching the DB
    for (const line of lines) {
      if (!line.itemId) return errorResponse(res, 400, 'E002', 'Item id is mandatory');
      const qty = parseFloat(line.quantity);
      if (isNaN(qty) || qty <= 0) return errorResponse(res, 400, 'E002', 'Quantity must be a positive number');
      if (line.soldPrice !== undefined && line.soldPrice !== null) {
        const price = parseFloat(line.soldPrice);
        if (isNaN(price) || price < 0) return errorResponse(res, 400, 'E002', 'Sold price must be a non-negative number');
      }
      if (line.discount !== undefined && line.discount !== null) {
        const disc = parseFloat(line.discount);
        if (isNaN(disc) || disc < 0) return errorResponse(res, 400, 'E002', 'Discount must be a non-negative number');
      }
    }

    const pm = (paymentMethod || '').trim().toLowerCase();
    const resolvedPayment = pm === 'card' ? 'card' : pm === 'credit' ? 'credit' : 'cash';
    const resolvedAmountPaid = amountPaid !== undefined && amountPaid !== null ? parseFloat(amountPaid) : null;

    const db = getDb();
    const shop = db.prepare('SELECT id FROM shop_detail WHERE shop_key = ?').get(req.user.shop_key);

    const completeSale = db.transaction(() => {
      const contact = (customerContact || '').trim();
      const name = (customerName || '').trim();
      const notesVal = (notes || '').trim();

      let custId;
      if (contact) {
        // Try to find existing customer by contact
        const existing = db.prepare('SELECT * FROM customer WHERE contact_number = ? AND shop_key = ?').get(contact, req.user.shop_key);
        if (existing) {
          if (name) db.prepare('UPDATE customer SET name = ? WHERE id = ?').run(name, existing.id);
          if (notesVal) db.prepare('UPDATE customer SET description = ? WHERE id = ?').run(notesVal, existing.id);
          custId = existing.id;
        } else {
          const r = db.prepare(`INSERT INTO customer (name, contact_number, description, shop_id, shop_key, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(name || contact, contact, notesVal || null, shop?.id || null, req.user.shop_key, req.user.id);
          custId = r.lastInsertRowid;
        }
      } else {
        // Generate walk-in contact matching Spring Boot generateWalkInContact()
        let walkInContact;
        do {
          walkInContact = `W${String(Date.now() % 10000000000).padStart(10, '0')}`;
        } while (db.prepare('SELECT id FROM customer WHERE contact_number = ?').get(walkInContact));
        const r = db.prepare(`INSERT INTO customer (name, contact_number, description, shop_id, shop_key, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(name || 'Walk-in Customer', walkInContact, notesVal || null, shop?.id || null, req.user.shop_key, req.user.id);
        custId = r.lastInsertRowid;
      }

      const cartResult = db.prepare(`
        INSERT INTO cart (customer_id, shop_id, shop_key, created_by, updated_by, sold_by, status, payment_method)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `).run(custId, shop?.id || null, req.user.shop_key, req.user.id, req.user.id, req.user.id, resolvedPayment);

      const cartId = cartResult.lastInsertRowid;
      let total = 0;
      const threshold = getLowStockThreshold(db, req.user.shop_key);

      for (const line of lines) {
        const qty = parseFloat(line.quantity);
        const item = db.prepare('SELECT * FROM item WHERE id = ? AND shop_key = ?').get(line.itemId, req.user.shop_key);
        if (!item) throw new Error(`Item ${line.itemId} not found`);
        if (item.quantity < qty) throw new Error(`Insufficient stock for item: ${item.name}`);

        const soldPrice = line.soldPrice !== undefined ? parseFloat(line.soldPrice) : item.price;
        const discount = line.discount !== undefined ? parseFloat(line.discount) : 0;

        db.prepare(`
          INSERT INTO cart_item (cart_id, item_id, quantity, sold_price, discount)
          VALUES (?, ?, ?, ?, ?)
        `).run(cartId, line.itemId, qty, soldPrice, discount);

        db.prepare(`UPDATE item SET quantity = quantity - ?, last_updated_date = datetime('now', 'localtime') WHERE id = ?`).run(qty, line.itemId);

        const updatedItem = db.prepare('SELECT quantity, name FROM item WHERE id = ?').get(line.itemId);
        if (updatedItem.quantity <= threshold) {
          createLowStockNotification(req.user.shop_key, updatedItem.name, line.itemId, updatedItem.quantity);
        }

        total += Math.max(0, (soldPrice * qty) - discount);
      }

      const grandTotalRounded = Math.round(total * 100) / 100;
      const finalAmountPaid = resolvedAmountPaid !== null ? resolvedAmountPaid : (resolvedPayment === 'credit' ? 0 : grandTotalRounded);

      if (resolvedPayment !== 'credit' && finalAmountPaid < grandTotalRounded) {
        throw new Error('UNDERPAID:Amount paid is less than total');
      }

      // Credit limit check
      if (resolvedPayment === 'credit') {
        const outstanding = Math.max(0, Math.round((grandTotalRounded - finalAmountPaid) * 100) / 100);
        if (outstanding > 0) {
          const { limit } = getEffectiveCreditLimit(db, custId, req.user.shop_key);
          const currentBalance = getCustomerBalance(db, custId, req.user.shop_key);
          if (currentBalance.outstandingBalance + outstanding > limit) {
            throw new Error(`CREDIT_LIMIT:Credit limit of ${limit} would be exceeded. Current balance: ${currentBalance.outstandingBalance}, New charge: ${outstanding}`);
          }
        }
      }

      // Mark cart completed, update amount_paid
      db.prepare(`UPDATE cart SET status = 1, amount_paid = ?, last_updated_date = datetime('now', 'localtime') WHERE id = ?`).run(finalAmountPaid, cartId);

      // Create ledger DEBIT entry for credit sales
      if (resolvedPayment === 'credit') {
        const outstanding = Math.max(0, Math.round((grandTotalRounded - finalAmountPaid) * 100) / 100);
        if (outstanding > 0) {
          db.prepare(`
            INSERT INTO customer_ledger (customer_id, shop_key, entry_type, amount, reference_type, reference_id, notes, created_by)
            VALUES (?, ?, 'DEBIT', ?, 'CART', ?, 'Credit express sale', ?)
          `).run(custId, req.user.shop_key, outstanding, cartId, req.user.id);
        }
      }

      return { cartId, total, finalAmountPaid };
    });

    const { cartId, total, finalAmountPaid } = completeSale();
    createSaleNotification(req.user.shop_key, req.user.id, cartId, total);
    broadcast(req.user.shop_key, 'STOCK_UPDATE', { cartId, event: 'EXPRESS_SALE' });

    const grandTotal = Math.round(total * 100) / 100;
    const changeDue = Math.round((finalAmountPaid - grandTotal) * 100) / 100;

    return successResponse(res, { cartId, grandTotal, changeDue }, 'Sale completed successfully');
  } catch (err) {
    if (err.message.startsWith('UNDERPAID:')) {
      return errorResponse(res, 400, 'E001', err.message.replace('UNDERPAID:', ''));
    }
    if (err.message.startsWith('CREDIT_LIMIT:')) {
      return errorResponse(res, 400, 'E001', err.message.replace('CREDIT_LIMIT:', ''));
    }
    if (err.message.includes('Insufficient stock')) {
      return res.status(409).json({ errorCode: 'E001', failReason: err.message });
    }
    if (err.message.includes('not found')) {
      return errorResponse(res, 400, 'E001', err.message);
    }
    return errorResponse(res, 500, 'E000', err.message);
  }
});


module.exports = router;
