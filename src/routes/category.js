const express = require('express');
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const multer = require('multer');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Parses category from JSON body or multipart "category" param (matches Spring Boot @RequestParam("category"))
function parseCategoryJson(req) {
  if (req.body && req.body.category) {
    try { return JSON.parse(req.body.category); } catch { return req.body; }
  }
  return req.body;
}

// POST /add-category
router.post('/add-category', authenticate, upload.single('file'), (req, res) => {
  try {
    const data = parseCategoryJson(req);
    const { name, description } = data;
    if (!name || !name.trim()) return errorResponse(res, 400, 'E002', 'Category name required');

    const db = getDb();

    // Unique name per shop — matches Spring Boot CategoryManagerService
    const existing = db.prepare('SELECT id FROM category WHERE shop_key = ? AND LOWER(name) = LOWER(?)').get(req.user.shop_key, name.trim());
    if (existing) return errorResponse(res, 400, 'E001', 'Category name already exists.');

    const shop = db.prepare('SELECT id FROM shop_detail WHERE shop_key = ?').get(req.user.shop_key);
    const result = db.prepare(
      'INSERT INTO category (name, description, shop_id, shop_key) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), description || null, shop?.id || null, req.user.shop_key);

    return successResponse(res, null, 'Category successfully added');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// PUT /edit-category
router.put('/edit-category', authenticate, upload.single('file'), (req, res) => {
  try {
    const data = parseCategoryJson(req);
    const { id, name, description } = data;
    if (!id) return errorResponse(res, 400, 'E002', 'Category id required');

    const db = getDb();
    const category = db.prepare('SELECT * FROM category WHERE id = ? AND shop_key = ?').get(id, req.user.shop_key);
    // Spring Boot returns 400 with "Entity does not exists." when category not found
    if (!category) return errorResponse(res, 400, 'E001', 'Entity does not exists.');

    // Spring Boot does NOT check for duplicate name during edit
    db.prepare(`UPDATE category SET name = ?, description = ?, last_updated_date = datetime('now') WHERE id = ?`)
      .run(name ? name.trim() : category.name, description !== undefined ? description : category.description, id);

    return successResponse(res, null, 'Category successfully updated');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /list
router.get('/list', authenticate, (req, res) => {
  try {
    const db = getDb();
    return successResponse(res, db.prepare('SELECT * FROM category WHERE shop_key = ? ORDER BY name').all(req.user.shop_key));
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
