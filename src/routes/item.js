const express = require('express');
const multer = require('multer');
const { getDb } = require('../config/database');
const { authenticate, requirePermission } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { buildPaginatedQuery, paginatedResponse } = require('../utils/pagination');

const { broadcast } = require('./events');
const { checkAndNotifyStock, clearStockAlertsForItem } = require('../services/notificationService');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ALLOWED_COLUMNS = ['i.id', 'i.name', 'i.item_code', 'i.price', 'i.quantity', 'i.buying_price', 'i.discount', 'i.created_date', 'i.last_updated_date', 'id', 'name', 'item_code', 'price', 'quantity', 'buying_price', 'discount', 'created_date', 'last_updated_date'];

const VALID_PAYMENT_METHODS = ['CASH', 'CARD', 'ONLINE', 'CHEQUE', 'TRANSFER'];

// Parses item data from either JSON body or multipart "item" param (matches Spring Boot @RequestParam("item"))
function parseItemJson(req) {
  if (req.body && req.body.item) {
    try { return JSON.parse(req.body.item); } catch { return req.body; }
  }
  return req.body;
}

router.post('/add-item', authenticate, requirePermission('MANAGE_INVENTORY'), upload.single('file'), (req, res) => {
  try {
    const data = parseItemJson(req);
    // Spring Boot uses "category" and "vendor" as integer fields in ItemManagerService
    const itemCode = data.itemCode || data.item_code;
    const name = data.name;
    const description = data.description || '';
    const price = parseFloat(data.price) || 0;
    const quantity = parseFloat(data.quantity) || 0;
    const buyingPrice = parseFloat(data.buyingPrice) || 0;
    const discount = parseFloat(data.discount) || 0;
    const categoryId = data.category || data.categoryId || null;
    const vendorId = data.vendor || data.vendorId || null;

    if (!name) return errorResponse(res, 400, 'E001', 'Invalid item name');
    if (price < 0) return errorResponse(res, 400, 'E001', "Price can't be negative");
    // Spring Boot has a bug: uses "Price can't be negative" for quantity too — replicate for identical behavior
    if (quantity < 0) return errorResponse(res, 400, 'E001', "Price can't be negative");
    if (buyingPrice < 0) return errorResponse(res, 400, 'E001', "Price can't be negative");
    if (discount < 0) return errorResponse(res, 400, 'E001', "Discount can't be negative");

    const db = getDb();

    // Spring Boot uses existsByItemCode — global uniqueness (not per-shop)
    if (itemCode && db.prepare('SELECT id FROM item WHERE item_code = ?').get(itemCode)) {
      return errorResponse(res, 400, 'E001', 'Item code already exists.');
    }

    // Validate category and vendor — Spring Boot requires both
    if (categoryId) {
      const cat = db.prepare('SELECT id FROM category WHERE id = ? AND shop_key = ?').get(categoryId, req.user.shop_key);
      if (!cat) return errorResponse(res, 400, 'E001', 'Invalid Category.');
    }
    if (vendorId) {
      const vend = db.prepare('SELECT id FROM vendor WHERE id = ? AND shop_key = ?').get(vendorId, req.user.shop_key);
      if (!vend) return errorResponse(res, 400, 'E001', 'Invalid Vendor');
    }

    const shop = db.prepare('SELECT id FROM shop_detail WHERE shop_key = ?').get(req.user.shop_key);
    const result = db.prepare(`
      INSERT INTO item (item_code, name, description, price, quantity, buying_price, discount, category_id, vendor_id, shop_id, shop_key, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemCode || null, name, description, price, quantity, buyingPrice, discount, categoryId || null, vendorId || null, shop?.id || null, req.user.shop_key, req.user.id);

    if (req.file) {
      db.prepare('INSERT OR REPLACE INTO item_image (item_id, image) VALUES (?, ?)').run(result.lastInsertRowid, req.file.buffer);
    }

    const savedItem = db.prepare('SELECT * FROM item WHERE id = ?').get(result.lastInsertRowid);
    broadcast(req.user.shop_key, 'ITEM_CREATED', { itemId: savedItem.id, name: savedItem.name });
    // Returns SuccessResponseDTO — matches Spring Boot ItemManagerService
    return successResponse(res, null, 'Item successfully added');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.post('/edit-item', authenticate, requirePermission('MANAGE_INVENTORY'), upload.single('file'), (req, res) => {
  try {
    const data = parseItemJson(req);
    const id = data.id;
    if (!id) return errorResponse(res, 400, 'E001', 'Invalid item.');

    const itemCode = data.itemCode || data.item_code;
    if (!itemCode || !itemCode.trim()) return errorResponse(res, 400, 'E001', 'Invalid Item Code.');

    const name = data.name;
    if (!name) return errorResponse(res, 400, 'E001', 'Invalid item name');

    const price = parseFloat(data.price) || 0;
    const quantity = parseFloat(data.quantity) || 0;
    const buyingPrice = parseFloat(data.buyingPrice) || 0;
    const discount = parseFloat(data.discount) || 0;
    const description = data.description || '';
    const categoryId = data.category || data.categoryId || null;
    const vendorId = data.vendor || data.vendorId || null;

    if (price < 0) return errorResponse(res, 400, 'E001', "Price can't be negative");
    if (quantity < 0) return errorResponse(res, 400, 'E001', "Quantity can't be negative");
    if (buyingPrice < 0) return errorResponse(res, 400, 'E001', "Buying price can't be negative");
    if (discount < 0) return errorResponse(res, 400, 'E001', "Discount can't be negative");

    const db = getDb();
    const item = db.prepare('SELECT * FROM item WHERE id = ? AND shop_key = ?').get(id, req.user.shop_key);
    if (!item) return errorResponse(res, 400, 'E001', 'Item not found.');

    if (itemCode.trim() !== item.item_code) {
      const existing = db.prepare('SELECT id FROM item WHERE item_code = ? AND shop_key = ? AND id != ?').get(itemCode.trim(), req.user.shop_key, id);
      if (existing) return errorResponse(res, 400, 'E001', 'Item code already exists.');
    }

    if (categoryId) {
      const cat = db.prepare('SELECT id FROM category WHERE id = ? AND shop_key = ?').get(categoryId, req.user.shop_key);
      if (!cat) return errorResponse(res, 400, 'E001', 'Invalid Category.');
    }
    if (vendorId) {
      const vend = db.prepare('SELECT id FROM vendor WHERE id = ? AND shop_key = ?').get(vendorId, req.user.shop_key);
      if (!vend) return errorResponse(res, 400, 'E001', 'Invalid Vendor');
    }

    db.prepare(`
      UPDATE item SET item_code = ?, name = ?, description = ?, price = ?, quantity = ?, buying_price = ?,
        discount = ?, category_id = ?, vendor_id = ?, updated_by = ?, last_updated_date = datetime('now', 'localtime')
      WHERE id = ?
    `).run(itemCode.trim(), name, description, price, quantity, buyingPrice, discount,
        categoryId || item.category_id, vendorId || item.vendor_id, req.user.id, id);

    if (req.file) {
      db.prepare('INSERT OR REPLACE INTO item_image (item_id, image) VALUES (?, ?)').run(id, req.file.buffer);
    }

    const updated = db.prepare('SELECT * FROM item WHERE id = ?').get(id);

    if (quantity > item.quantity) clearStockAlertsForItem(req.user.shop_key, id);
    checkAndNotifyStock(req.user.shop_key, updated.id, updated.name, updated.quantity);
    broadcast(req.user.shop_key, 'ITEM_UPDATED', { itemId: updated.id, name: updated.name, quantity: updated.quantity });
    // Returns SuccessResponseDTO — matches Spring Boot
    return successResponse(res, null, 'Item successfully saved');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.get('/by-code/:itemCode', authenticate, (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare(`
      SELECT i.*, c.name as category_name, v.name as vendor_name
      FROM item i
      LEFT JOIN category c ON i.category_id = c.id
      LEFT JOIN vendor v ON i.vendor_id = v.id
      WHERE i.item_code = ? AND i.shop_key = ?
    `).get(req.params.itemCode, req.user.shop_key);

    if (!item) return errorResponse(res, 404, 'E002', 'Item not found');
    const canSeeCost = req.user.role_type === 'ADMIN' || req.user.permissions.includes('MANAGE_INVENTORY');
    // ItemDetailResponseDTO shape matches Spring Boot fromEntity()
    return successResponse(res, {
      id: item.id,
      itemCode: item.item_code,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      category: item.category_id,
      vendor: item.vendor_id,
      buyingPrice: canSeeCost ? item.buying_price : null,
      discount: item.discount,
      description: canSeeCost ? item.description : null
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.get('/:itemId/image', authenticate, (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT id FROM item WHERE id = ? AND shop_key = ?').get(req.params.itemId, req.user.shop_key);
    if (!item) return errorResponse(res, 404, 'E002', 'Item not found');

    const img = db.prepare('SELECT image FROM item_image WHERE item_id = ?').get(req.params.itemId);
    if (!img?.image) return res.status(200).send();
    res.set('Content-Type', 'image/jpeg');
    return res.send(img.image);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.delete('/:itemId', authenticate, requirePermission('MANAGE_INVENTORY'), (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT * FROM item WHERE id = ? AND shop_key = ?').get(req.params.itemId, req.user.shop_key);
    if (!item) return errorResponse(res, 404, 'E002', 'Item not found.');

    try {
      db.prepare('DELETE FROM item_image WHERE item_id = ?').run(req.params.itemId);
      db.prepare('DELETE FROM item WHERE id = ?').run(req.params.itemId);
    } catch (ex) {
      return errorResponse(res, 400, 'E000', 'Cannot delete item — it is referenced by existing sales records.');
    }

    broadcast(req.user.shop_key, 'ITEM_DELETED', { itemId: parseInt(req.params.itemId) });
    return successResponse(res, null, 'Item deleted successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.get('/item-list', authenticate, (req, res) => {
  try {
    // Spring Boot item-list: 1-based page parameter
    const { page = 1, size = 10, sorting, filterColumn, operator, filterValue } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.max(parseInt(size) || 10, 1);
    const db = getDb();

    const base = `SELECT i.id, i.item_code, i.name, i.description, i.price, i.quantity, i.buying_price, i.discount,
      i.category_id, i.vendor_id, i.shop_key, i.created_by, i.created_date, i.last_updated_date,
      c.name as category_name, v.name as vendor_name
      FROM item i
      LEFT JOIN category c ON i.category_id = c.id
      LEFT JOIN vendor v ON i.vendor_id = v.id
      WHERE i.shop_key = ?`;
    const count = `SELECT COUNT(*) as total FROM item i WHERE i.shop_key = ?`;

    const { query, countQuery, params, countParams } = buildPaginatedQuery(
      base, count, [req.user.shop_key],
      safePage - 1, safeSize, sorting || 'i.name,ASC', filterColumn, operator, filterValue, ALLOWED_COLUMNS
    );

    const items = db.prepare(query).all(...params);
    const total = db.prepare(countQuery).get(...countParams).total;

    // Hide buyingPrice and description for users without MANAGE_INVENTORY permission
    const canSeeCost = req.user.role_type === 'ADMIN' || req.user.permissions.includes('MANAGE_INVENTORY');
    // Map to ItemProjection shape: {id, itemCode, name, price, quantity, category(int), vendor(int), buyingPrice, discount, description}
    const projected = items.map(i => ({
      id: i.id,
      itemCode: i.item_code,
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      category: i.category_id,
      vendor: i.vendor_id,
      buyingPrice: canSeeCost ? i.buying_price : null,
      discount: i.discount,
      description: canSeeCost ? i.description : null
    }));

    // ItemListResponseDTO { itemList: Page } — number is 0-based (Spring Page.getNumber())
    return successResponse(res, { itemList: paginatedResponse(projected, total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
