const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requirePermission } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { buildPaginatedQuery, paginatedResponse } = require('../utils/pagination');
const { createLowStockNotification, createSaleNotification } = require('../services/notificationService');
const { broadcast } = require('./events');

const router = express.Router();
const { LOW_STOCK_THRESHOLD } = require('../services/notificationService');
const ALLOWED_COLUMNS = ['id', 'status', 'payment_method', 'created_date', 'last_updated_date', 'amount_paid'];
const VALID_PAYMENT_METHODS = ['CASH', 'CARD', 'ONLINE', 'CHEQUE', 'TRANSFER'];

// Returns CartDetailResponseDTO matching Spring Boot exactly
// Fields: cartId, status, customerId, customerName, customerContact, displayName,
//         subtotal, totalDiscount, grandTotal, createdDate, lastUpdatedDate, items
function getCartDetail(db, cartId, shopKey) {
  const cart = db.prepare(`
    SELECT c.*, cu.name as customer_name, cu.contact_number as customer_contact,
      u.user_name as sold_by_name, u2.user_name as created_by_name
    FROM cart c
    LEFT JOIN customer cu ON c.customer_id = cu.id
    LEFT JOIN usr_user u ON c.sold_by = u.id
    LEFT JOIN usr_user u2 ON c.created_by = u2.id
    WHERE c.id = ? AND c.shop_key = ?
  `).get(cartId, shopKey);

  if (!cart) return null;

  const rawItems = db.prepare(`
    SELECT ci.*, i.name as item_name, i.item_code, i.price as item_price
    FROM cart_item ci
    JOIN item i ON ci.item_id = i.id
    WHERE ci.cart_id = ?
  `).all(cartId);

  // CartItemListResponceDTO shape: id, discount, quantity, soldPrice, itemId, itemName, itemCode, lineTotal
  const cartItems = rawItems.map(ci => ({
    id: ci.id,
    discount: ci.discount,
    quantity: ci.quantity,
    soldPrice: ci.sold_price,
    itemId: ci.item_id,
    itemName: ci.item_name,
    itemCode: ci.item_code,
    lineTotal: Math.max(0, Math.round((ci.sold_price * ci.quantity - (ci.discount || 0)) * 100) / 100)
  }));

  const subtotal = cartItems.reduce((s, ci) => s + ci.soldPrice * ci.quantity, 0);
  const totalDiscount = cartItems.reduce((s, ci) => s + (ci.discount || 0), 0);
  const grandTotal = Math.max(0, Math.round((subtotal - totalDiscount) * 100) / 100);
  const displayName = cartDisplayName(cart.customer_name, cart.customer_contact);

  // CartDetailResponseDTO matches Spring Boot exactly — no extra fields
  return {
    cartId: cart.id,
    status: cart.status,
    customerId: cart.customer_id,
    customerName: cart.customer_name,
    customerContact: cart.customer_contact,
    displayName,
    subtotal: Math.round(subtotal * 100) / 100,
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    grandTotal,
    createdDate: cart.created_date,
    lastUpdatedDate: cart.last_updated_date,
    items: cartItems
  };
}

// Returns CreateCartResponseDTO matching Spring Boot
// displayName: contactNumber first, then name — matches Spring Boot CartManagerService.displayName()
function cartDisplayName(customerName, customerContact) {
  if (customerContact && customerContact.trim()) return customerContact.trim();
  return customerName ? customerName.trim() : '';
}

function toCreateCartResponse(db, cartId, shopKey) {
  const cart = db.prepare(`
    SELECT c.id, c.customer_id, cu.name as customer_name, cu.contact_number as customer_contact
    FROM cart c LEFT JOIN customer cu ON c.customer_id = cu.id
    WHERE c.id = ? AND c.shop_key = ?
  `).get(cartId, shopKey);
  if (!cart) return null;
  return {
    cartId: cart.id,
    customerId: cart.customer_id,
    customerName: cart.customer_name,
    customerContact: cart.customer_contact,
    displayName: cartDisplayName(cart.customer_name, cart.customer_contact)
  };
}

function validateLineItem(line) {
  const qty = parseFloat(line.quantity);
  if (!line.itemId) throw new Error('Item id is mandatory');
  if (isNaN(qty) || qty <= 0) throw new Error('Quantity must be a positive number');
  if (line.soldPrice !== undefined && line.soldPrice !== null) {
    const price = parseFloat(line.soldPrice);
    if (isNaN(price) || price < 0) throw new Error('Sold price must be a non-negative number');
  }
  if (line.discount !== undefined && line.discount !== null) {
    const disc = parseFloat(line.discount);
    if (isNaN(disc) || disc < 0) throw new Error('Discount must be a non-negative number');
  }
  return qty;
}

router.post('/add-cart', authenticate, (req, res) => {
  try {
    const { customerId, customerName, customerContact, notes } = req.body;
    const db = getDb();
    const shop = db.prepare('SELECT id FROM shop_detail WHERE shop_key = ?').get(req.user.shop_key);

    let resolvedCustomerId = null;

    if (customerId && parseInt(customerId) > 0) {
      // Look up existing customer by id
      const existing = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_key = ?').get(customerId, req.user.shop_key);
      if (!existing) return errorResponse(res, 400, 'E001', 'Customer id is invalid');
      resolvedCustomerId = existing.id;
    } else {
      // contactNumber required when not providing customerId — matches Spring Boot
      const contact = (customerContact || '').trim();
      if (!contact) return errorResponse(res, 400, 'E002', 'Customer contact is required');

      const name = (customerName || '').trim();
      const notesVal = (notes || '').trim();

      // Find or create customer by contact
      const existingByContact = db.prepare('SELECT * FROM customer WHERE contact_number = ? AND shop_key = ?').get(contact, req.user.shop_key);
      if (existingByContact) {
        // Update name/notes if provided
        if (name) db.prepare('UPDATE customer SET name = ?, last_updated_date = datetime(\'now\') WHERE id = ?').run(name, existingByContact.id);
        if (notesVal) db.prepare('UPDATE customer SET description = ?, last_updated_date = datetime(\'now\') WHERE id = ?').run(notesVal, existingByContact.id);
        resolvedCustomerId = existingByContact.id;
      } else {
        const result = db.prepare(`
          INSERT INTO customer (name, contact_number, description, shop_id, shop_key, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(name || contact, contact, notesVal || null, shop?.id || null, req.user.shop_key, req.user.id);
        resolvedCustomerId = result.lastInsertRowid;
      }
    }

    const result = db.prepare(`
      INSERT INTO cart (customer_id, shop_id, shop_key, created_by, updated_by, status)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(resolvedCustomerId, shop?.id || null, req.user.shop_key, req.user.id, req.user.id);

    return successResponse(res, toCreateCartResponse(db, result.lastInsertRowid, req.user.shop_key), 'Cart created successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// Maps cart row to CartResponceDTO shape — includes itemCount and totalAmount
function toCartResponseDTO(db, cart) {
  const agg = db.prepare(`
    SELECT COUNT(*) as itemCount, COALESCE(SUM(sold_price * quantity - discount), 0) as totalAmount
    FROM cart_item WHERE cart_id = ?
  `).get(cart.id);
  const displayName = cartDisplayName(cart.customer_name, cart.customer_contact);
  return {
    id: cart.id,
    customerId: cart.customer_id,
    status: cart.status,
    customerName: cart.customer_name,
    customerContact: cart.customer_contact,
    displayName,
    itemCount: agg.itemCount,
    totalAmount: Math.round(agg.totalAmount * 100) / 100,
    lastUpdatedDate: cart.last_updated_date
  };
}

router.get('/ongoing-carts', authenticate, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT c.*, cu.name as customer_name, cu.contact_number as customer_contact
      FROM cart c
      LEFT JOIN customer cu ON c.customer_id = cu.id
      WHERE c.shop_key = ? AND c.status = 0
      ORDER BY c.last_updated_date DESC
    `).all(req.user.shop_key);
    const carts = rows.map(c => toCartResponseDTO(db, c));
    // CartOngoingListResponseDTO { carts: [...] }
    return successResponse(res, { carts });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.get('/get-carts', authenticate, (req, res) => {
  try {
    // Spring Boot get-carts: 1-based page parameter
    const { page = 1, size = 10, sorting, filterColumn, operator, filterValue, status } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.max(parseInt(size) || 10, 1);
    const db = getDb();

    let statusFilter = '';
    const params = [req.user.shop_key];

    if (status !== undefined && status !== '') {
      statusFilter = ' AND c.status = ?';
      params.push(parseInt(status));
    }

    const base = `SELECT c.*, cu.name as customer_name FROM cart c LEFT JOIN customer cu ON c.customer_id = cu.id WHERE c.shop_key = ?${statusFilter}`;
    const count = `SELECT COUNT(*) as total FROM cart c WHERE c.shop_key = ?${statusFilter}`;

    const { query, countQuery, params: qParams, countParams } = buildPaginatedQuery(
      base, count, params,
      safePage - 1, safeSize, sorting || 'c.id,DESC', filterColumn, operator, filterValue, ALLOWED_COLUMNS
    );

    const rows = db.prepare(query).all(...qParams);
    const total = db.prepare(countQuery).get(...countParams).total;
    const items = rows.map(c => toCartResponseDTO(db, c));

    // CartListItemResponseDTO { cartList: Page } — number is 0-based (Spring Page.getNumber())
    return successResponse(res, { cartList: paginatedResponse(items, total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.post('/add-cartItem', authenticate, (req, res) => {
  try {
    const { cartId, cartItemList } = req.body;
    if (!cartId || !cartItemList) return errorResponse(res, 400, 'E002', 'Cart items are required');

    const db = getDb();
    const cart = db.prepare('SELECT * FROM cart WHERE id = ? AND shop_key = ?').get(cartId, req.user.shop_key);
    if (!cart) return errorResponse(res, 400, 'E001', 'Cart id is invalid');
    if (cart.status !== 0) return errorResponse(res, 400, 'E001', 'Cart is not pending');

    // Cart must have a customer before adding items — matches Spring Boot resolveCartForItems
    if (!cart.customer_id) return errorResponse(res, 400, 'E001', 'Cart must have a customer');

    for (const line of cartItemList) {
      let qty;
      try { qty = validateLineItem(line); } catch (e) { return errorResponse(res, 400, 'E002', e.message); }

      const item = db.prepare('SELECT * FROM item WHERE id = ? AND shop_key = ?').get(line.itemId, req.user.shop_key);
      if (!item) return errorResponse(res, 400, 'E001', 'Item id is invalid');

      const soldPrice = line.soldPrice !== undefined && line.soldPrice !== null ? parseFloat(line.soldPrice) : item.price;
      const discount = line.discount !== undefined && line.discount !== null ? parseFloat(line.discount) : 0;

      // Merge if same item+price+discount already exists — matches Spring Boot addOrUpdateCartLine
      const existing = db.prepare(
        'SELECT * FROM cart_item WHERE cart_id = ? AND item_id = ? AND sold_price = ? AND discount = ?'
      ).get(cartId, line.itemId, soldPrice, discount);

      if (existing) {
        db.prepare('UPDATE cart_item SET quantity = quantity + ? WHERE id = ?').run(qty, existing.id);
      } else {
        db.prepare(`INSERT INTO cart_item (cart_id, item_id, quantity, sold_price, discount) VALUES (?, ?, ?, ?, ?)`)
          .run(cartId, line.itemId, qty, soldPrice, discount);
      }
    }

    db.prepare(`UPDATE cart SET updated_by = ?, last_updated_date = datetime('now') WHERE id = ?`).run(req.user.id, cartId);

    // Returns AddCartItemResponseDTO { cartId } matching Spring Boot
    return successResponse(res, { cartId: parseInt(cartId) }, 'Items added to cart');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// Both /get-cart and /detail serve identical data (Spring Boot has both endpoints)
router.get('/:cartId/get-cart', authenticate, (req, res) => {
  try {
    const db = getDb();
    const cart = getCartDetail(db, req.params.cartId, req.user.shop_key);
    if (!cart) return errorResponse(res, 400, 'E001', 'Cart not found');
    return successResponse(res, cart);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.get('/:cartId/detail', authenticate, (req, res) => {
  try {
    const db = getDb();
    const cart = getCartDetail(db, req.params.cartId, req.user.shop_key);
    if (!cart) return errorResponse(res, 400, 'E001', 'Cart not found');
    return successResponse(res, cart);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// edit-cart: matches Spring Boot — takes ONE CartItemListDTO (single item update by id)
// Cannot change item, can update quantity/discount/soldPrice; returns SuccessResponseDTO
router.put('/edit-cart', authenticate, (req, res) => {
  try {
    const { id, itemId, quantity, soldPrice, discount } = req.body;
    if (!id) return errorResponse(res, 400, 'E002', 'Cart item id is required');

    const db = getDb();
    const cartItem = db.prepare(`
      SELECT ci.*, c.status as cart_status FROM cart_item ci JOIN cart c ON ci.cart_id = c.id
      WHERE ci.id = ? AND c.shop_key = ?
    `).get(id, req.user.shop_key);
    if (!cartItem) return errorResponse(res, 400, 'E001', 'Cart item not found');
    if (cartItem.cart_status !== 0) return errorResponse(res, 400, 'E001', 'Only pending carts can be edited');

    // Cannot change item — matches Spring Boot
    if (itemId && itemId !== 0 && itemId !== cartItem.item_id) {
      return errorResponse(res, 400, 'E001', "Item mismatch, can't change the item");
    }

    if (quantity !== undefined && quantity !== null) {
      const qty = parseFloat(quantity);
      if (isNaN(qty) || qty <= 0) return errorResponse(res, 400, 'E002', 'Quantity must be greater than zero');
      db.prepare('UPDATE cart_item SET quantity = ? WHERE id = ?').run(qty, id);
    }
    if (discount !== undefined && discount !== null) {
      db.prepare('UPDATE cart_item SET discount = ? WHERE id = ?').run(parseFloat(discount), id);
    }
    if (soldPrice !== undefined && soldPrice !== null) {
      db.prepare('UPDATE cart_item SET sold_price = ? WHERE id = ?').run(parseFloat(soldPrice), id);
    }

    db.prepare(`UPDATE cart SET updated_by = ?, last_updated_date = datetime('now') WHERE id = ?`).run(req.user.id, cartItem.cart_id);

    return successResponse(res, null, 'Cart item updated');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.delete('/item/:cartItemId', authenticate, (req, res) => {
  try {
    const db = getDb();
    const cartItem = db.prepare(`
      SELECT ci.*, c.status as cart_status FROM cart_item ci
      JOIN cart c ON ci.cart_id = c.id
      WHERE ci.id = ? AND c.shop_key = ?
    `).get(req.params.cartItemId, req.user.shop_key);

    if (!cartItem) return errorResponse(res, 400, 'E001', 'Cart item not found');
    if (cartItem.cart_status !== 0) return errorResponse(res, 400, 'E001', 'Only pending carts can be edited');

    db.prepare('DELETE FROM cart_item WHERE id = ?').run(req.params.cartItemId);

    return successResponse(res, null, 'Cart item removed');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// update-cart: matches Spring Boot CartDTO {id, customerId}
// Only sets customer if cart currently has none
router.post('/update-cart', authenticate, (req, res) => {
  try {
    const { id, customerId } = req.body;
    const cartId = id || req.body.cartId;
    if (!cartId) return errorResponse(res, 400, 'E002', 'Cart id is required');

    const db = getDb();
    const cart = db.prepare('SELECT * FROM cart WHERE id = ? AND shop_key = ? AND status = 0').get(cartId, req.user.shop_key);
    if (!cart) return errorResponse(res, 400, 'E001', 'Cart not found');

    if (cart.status !== 0) return errorResponse(res, 400, 'E001', "Cart can't be updated");

    // Only set customer if cart currently has none — matches Spring Boot
    if (!cart.customer_id && customerId && parseInt(customerId) > 0) {
      const customer = db.prepare('SELECT id FROM customer WHERE id = ? AND shop_key = ?').get(customerId, req.user.shop_key);
      if (!customer) return errorResponse(res, 400, 'E001', 'Customer not found');
      db.prepare('UPDATE cart SET customer_id = ? WHERE id = ?').run(customerId, cartId);
    }

    db.prepare(`UPDATE cart SET updated_by = ?, last_updated_date = datetime('now') WHERE id = ?`).run(req.user.id, cartId);

    return successResponse(res, null, 'Cart updated');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.post('/complete-cart', authenticate, (req, res) => {
  try {
    const { cartId, paymentMethod, amountPaid } = req.body;
    if (!cartId) return errorResponse(res, 400, 'E002', 'Cart id is required');

    // PaymentMethodUtil.normalize(): "card" → "card", everything else → "cash" — matches Spring Boot
    const resolvedPayment = (paymentMethod && paymentMethod.trim().toLowerCase() === 'card') ? 'card' : 'cash';

    const db = getDb();
    const cart = db.prepare('SELECT * FROM cart WHERE id = ? AND shop_key = ?').get(cartId, req.user.shop_key);
    if (!cart) return errorResponse(res, 400, 'E001', 'Cart not found');
    if (cart.status !== 0) return errorResponse(res, 400, 'E001', 'Cart is not pending');

    let total = 0;

    // Stock snapshot and decrement inside single transaction — prevents TOCTOU race
    const decrementStock = db.transaction(() => {
      const cartItems = db.prepare(
        'SELECT ci.*, i.quantity as stock, i.name as item_name FROM cart_item ci JOIN item i ON ci.item_id = i.id WHERE ci.cart_id = ?'
      ).all(cartId);

      if (cartItems.length === 0) throw new Error('Cart is empty');

      // Validate quantities > 0
      for (const ci of cartItems) {
        if (ci.quantity <= 0) throw new Error('Quantity must be greater than zero');
        total += Math.max(0, ci.sold_price * ci.quantity - (ci.discount || 0));
      }

      // Validate amountPaid >= grandTotal before touching stock
      const grandTotalPreview = Math.round(total * 100) / 100;
      const paidAmt = amountPaid !== undefined && amountPaid !== null ? parseFloat(amountPaid) : grandTotalPreview;
      if (paidAmt < grandTotalPreview) {
        throw new Error('UNDERPAID:Amount paid is less than total');
      }

      for (const ci of cartItems) {
        if (ci.stock < ci.quantity) {
          throw new Error(`Insufficient stock for item: ${ci.item_name}`);
        }
        db.prepare(`UPDATE item SET quantity = quantity - ?, last_updated_date = datetime('now') WHERE id = ?`).run(ci.quantity, ci.item_id);

        const newQty = db.prepare('SELECT quantity, name FROM item WHERE id = ?').get(ci.item_id);
        if (newQty.quantity <= LOW_STOCK_THRESHOLD) {
          createLowStockNotification(req.user.shop_key, newQty.name, ci.item_id, newQty.quantity);
        }
      }

      db.prepare(`
        UPDATE cart SET status = 1, payment_method = ?, amount_paid = ?, sold_by = ?, updated_by = ?, last_updated_date = datetime('now')
        WHERE id = ?
      `).run(resolvedPayment, paidAmt, req.user.id, req.user.id, cartId);

      return { total, paidAmt };
    });

    const result = decrementStock();
    total = result.total;
    const resolvedAmountPaid = result.paidAmt;

    createSaleNotification(req.user.shop_key, req.user.id, cartId, total);
    broadcast(req.user.shop_key, 'STOCK_UPDATE', { cartId, event: 'CART_COMPLETED' });

    const grandTotal = Math.round(total * 100) / 100;
    const changeDue = Math.round((resolvedAmountPaid - grandTotal) * 100) / 100;

    // ExpressSaleResponseDTO matches Spring Boot: {status, message, cartId, grandTotal, changeDue}
    return successResponse(res, {
      cartId: parseInt(cartId),
      grandTotal,
      changeDue
    }, 'Cart completed successfully');
  } catch (err) {
    if (err.message.startsWith('UNDERPAID:')) {
      return errorResponse(res, 400, 'E001', err.message.replace('UNDERPAID:', ''));
    }
    // Spring Boot uses 409 CONFLICT for insufficient stock
    if (err.message.includes('Insufficient stock')) {
      return res.status(409).json({ errorCode: 'E001', failReason: err.message });
    }
    // Spring Boot uses MANDATORY_DATA_MISSING (E002) for "Cart is empty"
    if (err.message.includes('empty')) {
      return errorResponse(res, 400, 'E002', err.message);
    }
    if (err.message.includes('zero')) {
      return errorResponse(res, 400, 'E001', err.message);
    }
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.post('/cancel-cart', authenticate, (req, res) => {
  try {
    const { cartId } = req.body;
    if (!cartId) return errorResponse(res, 400, 'E002', 'Cart id is required');

    const db = getDb();
    const cart = db.prepare('SELECT * FROM cart WHERE id = ? AND shop_key = ?').get(cartId, req.user.shop_key);
    if (!cart) return errorResponse(res, 400, 'E001', 'Cart not found');
    if (cart.status !== 0) return errorResponse(res, 400, 'E001', 'Only pending carts can be cancelled');

    db.prepare(`UPDATE cart SET status = -1, updated_by = ?, last_updated_date = datetime('now') WHERE id = ?`).run(req.user.id, cartId);

    return successResponse(res, null, 'Cart cancelled');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
