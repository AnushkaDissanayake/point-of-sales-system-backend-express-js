const express = require('express');
const multer = require('multer');
const { getDb } = require('../config/database');
const { authenticate, requirePermission } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { buildPaginatedQuery, paginatedResponse } = require('../utils/pagination');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ALLOWED_COLUMNS = ['id', 'name', 'contact_number', 'email', 'address', 'created_date', 'last_updated_date', 'next_arrival_date'];

function getVendorCategories(db, vendorId) {
  return db.prepare(`
    SELECT c.id, c.name FROM category c
    JOIN vendor_category vc ON c.id = vc.category_id
    WHERE vc.vendor_id = ?
  `).all(vendorId);
}

// Parses from JSON body or multipart "vendor" param (matches Spring Boot @RequestParam("vendor"))
function parseVendorJson(req) {
  if (req.body && req.body.vendor) {
    try { return JSON.parse(req.body.vendor); } catch { return req.body; }
  }
  return req.body;
}

// VendorDTO matches Spring Boot exactly: {id, name, contact, email}
function toVendorDTO(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, contact: row.contact_number, email: row.email };
}

router.post('/add-vendor', authenticate, upload.single('file'), (req, res) => {
  try {
    const data = parseVendorJson(req);
    // Spring Boot uses "contact" field
    const name = data.name;
    const contactNumber = data.contact || data.contactNumber;
    const email = data.email;
    const address = data.address;
    const description = data.description;
    // Spring Boot uses "lastArrivalDate" / "nextArrivalDate"
    const lastArrivedDate = data.lastArrivalDate || data.lastArrivedDate;
    const nextArrivalDate = data.nextArrivalDate;
    const categoryIds = data.categories || data.categoryIds;

    if (!name) return errorResponse(res, 400, 'E001', 'Invalid vendor name');

    const db = getDb();

    if (contactNumber) {
      // Spring Boot uses existsByContactNumber — global uniqueness, not per-shop
      const existing = db.prepare('SELECT id FROM vendor WHERE contact_number = ?').get(contactNumber);
      if (existing) return errorResponse(res, 400, 'E001', 'Contact number already exists.');
    }

    const shop = db.prepare('SELECT id FROM shop_detail WHERE shop_key = ?').get(req.user.shop_key);
    const result = db.prepare(`
      INSERT INTO vendor (name, contact_number, email, address, description, last_arrived_date, next_arrival_date, shop_id, shop_key, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, contactNumber || null, email || null, address || null, description || null,
      lastArrivedDate || null, nextArrivalDate || null,
      shop?.id || null, req.user.shop_key, req.user.id
    );

    const vendorId = result.lastInsertRowid;

    if (categoryIds) {
      const cats = typeof categoryIds === 'string' ? JSON.parse(categoryIds) : categoryIds;
      for (const catId of cats) {
        db.prepare('INSERT OR IGNORE INTO vendor_category (vendor_id, category_id) VALUES (?, ?)').run(vendorId, catId);
      }
    }

    if (req.file) {
      db.prepare('INSERT OR REPLACE INTO vendor_image (vendor_id, image) VALUES (?, ?)').run(vendorId, req.file.buffer);
    }

    return successResponse(res, null, 'Vendor successfully added');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.post('/edit-vendor', authenticate, upload.single('file'), (req, res) => {
  try {
    const data = parseVendorJson(req);
    const id = data.id;
    const name = data.name;
    const contactNumber = data.contact || data.contactNumber;
    const email = data.email;
    const address = data.address;
    const description = data.description;
    const lastArrivedDate = data.lastArrivalDate || data.lastArrivedDate;
    const nextArrivalDate = data.nextArrivalDate;
    const categoryIds = data.categories || data.categoryIds;
    if (!id) return errorResponse(res, 400, 'E002', 'Vendor ID is mandatory.');

    const db = getDb();
    const vendor = db.prepare('SELECT * FROM vendor WHERE id = ? AND shop_key = ?').get(id, req.user.shop_key);
    // Spring Boot throws 400 "Vendor does not exist." — not 404
    if (!vendor) return errorResponse(res, 400, 'E001', 'Vendor does not exist.');

    // Duplicate contact check (exclude self)
    if (contactNumber && contactNumber !== vendor.contact_number) {
      // Spring Boot existsByContactNumber — global, no self-exclusion (if contact unchanged, it won't be checked due to the !== check above)
      const existing = db.prepare('SELECT id FROM vendor WHERE contact_number = ?').get(contactNumber);
      if (existing) return errorResponse(res, 400, 'E001', 'Contact number already exists.');
    }

    db.prepare(`
      UPDATE vendor SET name = ?, contact_number = ?, email = ?, address = ?, description = ?,
        last_arrived_date = ?, next_arrival_date = ?, updated_by = ?, last_updated_date = datetime('now', 'localtime')
      WHERE id = ?
    `).run(
      name || vendor.name,
      contactNumber !== undefined ? contactNumber : vendor.contact_number,
      email !== undefined ? email : vendor.email,
      address !== undefined ? address : vendor.address,
      description !== undefined ? description : vendor.description,
      lastArrivedDate !== undefined ? lastArrivedDate : vendor.last_arrived_date,
      nextArrivalDate !== undefined ? nextArrivalDate : vendor.next_arrival_date,
      req.user.id, id
    );

    if (categoryIds !== undefined) {
      const cats = typeof categoryIds === 'string' ? JSON.parse(categoryIds) : categoryIds;
      db.prepare('DELETE FROM vendor_category WHERE vendor_id = ?').run(id);
      for (const catId of cats) {
        db.prepare('INSERT OR IGNORE INTO vendor_category (vendor_id, category_id) VALUES (?, ?)').run(id, catId);
      }
    }

    if (req.file) {
      db.prepare('INSERT OR REPLACE INTO vendor_image (vendor_id, image) VALUES (?, ?)').run(id, req.file.buffer);
    }

    return successResponse(res, null, 'Vendor successfully updated');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.get('/vendor-list', authenticate, (req, res) => {
  try {
    // Spring Boot vendor-list: 1-based page, default sort "id, desc"
    const { page = 1, size = 10, sorting, filterColumn, operator, filterValue } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.max(parseInt(size) || 10, 1);
    const db = getDb();

    const base = `SELECT * FROM vendor WHERE shop_key = ?`;
    const count = `SELECT COUNT(*) as total FROM vendor WHERE shop_key = ?`;

    const { query, countQuery, params, countParams } = buildPaginatedQuery(
      base, count, [req.user.shop_key],
      safePage - 1, safeSize, sorting || 'id,DESC', filterColumn, operator, filterValue, ALLOWED_COLUMNS
    );

    const items = db.prepare(query).all(...params);
    const total = db.prepare(countQuery).get(...countParams).total;

    // Batch-fetch all categories in one query — no N+1
    const vendorIds = items.map(v => v.id);
    const allCategories = vendorIds.length > 0
      ? db.prepare(`
          SELECT c.id, c.name, vc.vendor_id FROM category c
          JOIN vendor_category vc ON c.id = vc.category_id
          WHERE vc.vendor_id IN (${vendorIds.map(() => '?').join(',')})
        `).all(...vendorIds)
      : [];

    const catsByVendor = {};
    for (const cat of allCategories) {
      if (!catsByVendor[cat.vendor_id]) catsByVendor[cat.vendor_id] = [];
      catsByVendor[cat.vendor_id].push({ id: cat.id, name: cat.name });
    }

    const enriched = items.map(v => toVendorDTO(v));

    // Wrapped in VendorListItemResponseDTO { vendorList: Page } — number is 0-based
    return successResponse(res, { vendorList: paginatedResponse(enriched, total, safePage - 1, safeSize) });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.get('/:vendorId/image', authenticate, (req, res) => {
  try {
    const db = getDb();
    const vendor = db.prepare('SELECT id FROM vendor WHERE id = ? AND shop_key = ?').get(req.params.vendorId, req.user.shop_key);
    if (!vendor) return errorResponse(res, 404, 'E002', 'Vendor not found');

    const img = db.prepare('SELECT image FROM vendor_image WHERE vendor_id = ?').get(req.params.vendorId);
    if (!img?.image) return res.status(200).send();
    res.set('Content-Type', 'image/jpeg');
    return res.send(img.image);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
