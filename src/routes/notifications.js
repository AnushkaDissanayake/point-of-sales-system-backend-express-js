const express = require('express');
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { LOW_STOCK_THRESHOLD } = require('../services/notificationService');

const router = express.Router();

// Sync low-stock notifications on read — matches Spring Boot NotificationService.getNotifications()
function syncLowStockNotifications(shopKey) {
  try {
    const db = getDb();
    const lowStockItems = db.prepare('SELECT * FROM item WHERE shop_key = ? AND quantity <= ?').all(shopKey, LOW_STOCK_THRESHOLD);
    const users = db.prepare('SELECT id FROM usr_user WHERE shop_key = ? AND enabled = 1').all(shopKey);

    for (const item of lowStockItems) {
      const type = item.quantity <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK';
      const title = item.quantity <= 0 ? 'Out of stock' : 'Low stock alert';
      const desc = item.quantity <= 0
        ? `${item.name} (${item.item_code || ''}) is out of stock`
        : `${item.name} (${item.item_code || ''}) is low — only ${Math.floor(item.quantity)} left`;

      for (const u of users) {
        const exists = db.prepare(
          'SELECT id FROM notification WHERE shop_key = ? AND user_id = ? AND type = ? AND reference_id = ?'
        ).get(shopKey, u.id, type, item.id);
        if (!exists) {
          db.prepare(`
            INSERT INTO notification (shop_key, title, description, type, reference_type, reference_id, status, user_id)
            VALUES (?, ?, ?, ?, 'ITEM', ?, 0, ?)
          `).run(shopKey, title, desc, type, item.id, u.id);
        }
      }
    }
  } catch (err) {
    console.error('Sync low stock error:', err.message);
  }
}

// GET / — NotificationListResponseDTO { status, notifications, unreadCount }
router.get('/', authenticate, (req, res) => {
  try {
    const { limit = 15 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 15, 1), 50);
    const db = getDb();

    syncLowStockNotifications(req.user.shop_key);

    const rows = db.prepare(`
      SELECT * FROM notification WHERE user_id = ? AND shop_key = ?
      ORDER BY date_and_time DESC LIMIT ?
    `).all(req.user.id, req.user.shop_key, safeLimit);

    // Map to Spring Boot NotificationDTO: { id, title, description, type, referenceType, referenceId, read, createdAt }
    const notifications = rows.map(n => ({
      id: n.id,
      title: n.title,
      description: n.description,
      type: n.type,
      referenceType: n.reference_type,
      referenceId: n.reference_id,
      read: n.status === 1,
      createdAt: n.date_and_time || ''
    }));

    const unreadCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM notification WHERE user_id = ? AND shop_key = ? AND status = 0'
    ).get(req.user.id, req.user.shop_key).cnt;

    // NotificationListResponseDTO { status, notifications, unreadCount } — matches Spring Boot exactly
    return successResponse(res, { status: 'SUCCESS', notifications, unreadCount });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// GET /unread-count — also syncs
router.get('/unread-count', authenticate, (req, res) => {
  try {
    const db = getDb();
    syncLowStockNotifications(req.user.shop_key);
    const unread = db.prepare(
      'SELECT COUNT(*) as count FROM notification WHERE user_id = ? AND shop_key = ? AND status = 0'
    ).get(req.user.id, req.user.shop_key).count;
    // NotificationListResponseDTO { status, notifications: [], unreadCount } — matches Spring Boot
    return successResponse(res, { status: 'SUCCESS', notifications: [], unreadCount: unread });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// Static route MUST be before parameterised /:id/read
router.patch('/read-all', authenticate, (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE notification SET status = 1 WHERE user_id = ? AND shop_key = ?').run(req.user.id, req.user.shop_key);
    return successResponse(res, null, 'All notifications marked as read');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

router.patch('/:id/read', authenticate, (req, res) => {
  try {
    const db = getDb();
    const notif = db.prepare('SELECT * FROM notification WHERE id = ? AND user_id = ? AND shop_key = ?').get(req.params.id, req.user.id, req.user.shop_key);
    if (!notif) return errorResponse(res, 404, 'E001', 'Notification not found');
    db.prepare('UPDATE notification SET status = 1 WHERE id = ?').run(req.params.id);
    return successResponse(res, null, 'Notification marked as read');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
