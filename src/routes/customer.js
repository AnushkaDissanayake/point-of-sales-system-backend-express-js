const express = require('express');
const multer = require('multer');
const { getDb } = require('../config/database');
const { authenticate, requirePermission } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { buildPaginatedQuery, paginatedResponse } = require('../utils/pagination');

const router = express.Router();
const ALLOWED_COLUMNS = ['id', 'name', 'contact_number', 'email', 'address', 'created_date', 'last_updated_date'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Maps to Spring Boot CustomerDTO exactly: {id, name, contact, email}
function toCustomerDTO(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, contact: row.contact_number, email: row.email };
}

// Parses from JSON body or multipart "customer" param (matches Spring Boot @RequestParam("customer"))
function parseCustomerJson(req) {
  if (req.body && req.body.customer) {
    try { return JSON.parse(req.body.customer); } catch { return req.body; }
  }
  return req.body;
}

// POST /add-customer
router.post('/add-customer', authenticate, upload.single('file'), (req, res) => {
  try {
    const data = parseCustomerJson(req);
    // Spring Boot uses "contact" field not "contactNumber"
    const name = data.name;
    const contactNumber = data.contact || data.contactNumber;
    const address = data.address;
    const email = data.email;
    const description = data.description;
    if (!name || !name.trim()) return errorResponse(res, 400, 'E001', 'Invalid customer name');

    const db = getDb();

    // Duplicate contact number check — matches Spring Boot CustomerManagerService
    if (contactNumber) {
      // Spring Boot uses existsByContactNumber — global uniqueness (not per-shop)
      const existing = db.prepare('SELECT id FROM customer WHERE contact_number = ?').get(contactNumber);
      if (existing) return errorResponse(res, 400, 'E003', 'Contact number already exists.');
    }

    const shop = db.prepare('SELECT id FROM shop_detail WHERE shop_key = ?').get(req.user.shop_key);
    const result = db.prepare(`
      INSERT INTO customer (name, contact_number, address, email, description, shop_id, shop_key, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, contactNumber || null, address || null, email || null, description || null,
        shop?.id || null, req.user.shop_key, req.user.id);

    if (req.file) {
      db.prepare('INSERT OR REPLACE INTO customer_image (customer_id, image) VALUES (?, ?)').run(result.lastInsertRowid, req.file.buffer);
    }

    return successResponse(res, null, 'Customer successfully added');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// POST /edit-customer
router.post('/edit-customer', authenticate, upload.single('file'), (req, res) => {
  try {
    const data = parseCustomerJson(req);
    const id = data.id;
    const name = data.name;
    const contactNumber = data.contact || data.contactNumber;
    const address = data.address;
    const email = data.email;
    const description = data.description;
    if (!id) return errorResponse(res, 400, 'E002', 'Customer id required');

    const db = getDb();
    const customer = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_key = ?').get(id, req.user.shop_key);
    if (!customer) return errorResponse(res, 404, 'E002', 'Customer not found');

    // Duplicate contact check (exclude self)
    if (contactNumber && contactNumber !== customer.contact_number) {
      // Spring Boot uses existsByContactNumber — global uniqueness (not per-shop)
      const existing = db.prepare('SELECT id FROM customer WHERE contact_number = ?').get(contactNumber);
      if (existing) return errorResponse(res, 400, 'E003', 'Contact number already exists.');
    }

    db.prepare(`
      UPDATE customer SET name = ?, contact_number = ?, address = ?, email = ?, description = ?,
        updated_by = ?, last_updated_date = datetime('now')
      WHERE id = ?
    `).run(
      name || customer.name,
      contactNumber !== undefined ? contactNumber : customer.contact_number,
      address !== undefined ? address : customer.address,
      email !== undefined ? email : customer.email,
      description !== undefined ? description : customer.description,
      req.user.id, id
    );

    if (req.file) {
      db.prepare('INSERT OR REPLACE INTO customer_image (customer_id, image) VALUES (?, ?)').run(id, req.file.buffer);
    }

    return successResponse(res, null, 'Customer successfully saved');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// DELETE /:customerId
router.delete('/:customerId', authenticate, (req, res) => {
  try {
    const db = getDb();
    const customer = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_key = ?').get(req.params.customerId, req.user.shop_key);
    if (!customer) return errorResponse(res, 404, 'E002', 'Customer not found.');

    try {
      db.prepare('DELETE FROM customer_image WHERE customer_id = ?').run(req.params.customerId);
      db.prepare('DELETE FROM customer WHERE id = ?').run(req.params.customerId);
    } catch (ex) {
      return errorResponse(res, 400, 'E000', 'Cannot delete customer — they are referenced by existing sales records.');
    }

    return successResponse(res, null, 'Customer deleted successfully');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /:customerId/image
router.get('/:customerId/image', authenticate, (req, res) => {
  try {
    const db = getDb();
    const customer = db.prepare('SELECT id FROM customer WHERE id = ? AND shop_key = ?').get(req.params.customerId, req.user.shop_key);
    if (!customer) return errorResponse(res, 404, 'E002', 'Customer not found');

    const img = db.prepare('SELECT image FROM customer_image WHERE customer_id = ?').get(req.params.customerId);
    if (!img?.image) return res.status(200).send();
    res.set('Content-Type', 'image/jpeg');
    return res.send(img.image);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /customer-list
router.get('/customer-list', authenticate, (req, res) => {
  try {
    const { page = 1, size = 10, sorting, filterColumn, operator, filterValue } = req.query;
    const db = getDb();
    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.max(parseInt(size) || 10, 1);

    const base = `SELECT * FROM customer WHERE shop_key = ?`;
    const count = `SELECT COUNT(*) as total FROM customer WHERE shop_key = ?`;

    // Spring Boot customer-list default sort: "id, desc"
    const { query, countQuery, params, countParams } = buildPaginatedQuery(
      base, count, [req.user.shop_key],
      safePage - 1, safeSize, sorting || 'id,DESC', filterColumn, operator, filterValue, ALLOWED_COLUMNS
    );

    const items = db.prepare(query).all(...params).map(toCustomerDTO);
    const total = db.prepare(countQuery).get(...countParams).total;

    // CustomerListResponseDTO { customerList: Page } — number field is 0-based (Spring Page.getNumber())
    return successResponse(res, { customerList: paginatedResponse(items, total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
