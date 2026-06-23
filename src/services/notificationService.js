const { getDb } = require('../config/database');

const LOW_STOCK_THRESHOLD = 10;

function createNotification(shopKey, userId, title, description, type, referenceType, referenceId) {
  try {
    const db = getDb();

    // Dedup: skip if an unread notification of same type+reference already exists
    if (referenceId) {
      const existing = db.prepare(
        'SELECT id FROM notification WHERE shop_key = ? AND type = ? AND reference_id = ? AND reference_type = ? AND status = 0'
      ).get(shopKey, type, referenceId, referenceType);
      if (existing) return;
    }

    db.prepare(`
      INSERT INTO notification (shop_key, title, description, type, reference_type, reference_id, status, user_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(shopKey, title, description, type, referenceType, referenceId || null, userId || null);
  } catch (err) {
    console.error('Notification create error:', err.message);
  }
}

// Called after stock decrement — checks LOW_STOCK and OUT_OF_STOCK
function checkAndNotifyStock(shopKey, itemId, itemName, newQuantity) {
  try {
    const db = getDb();

    if (newQuantity <= 0) {
      // OUT_OF_STOCK — remove any existing low-stock alert for this item first
      db.prepare(
        "DELETE FROM notification WHERE shop_key = ? AND type = 'LOW_STOCK' AND reference_id = ? AND status = 0"
      ).run(shopKey, itemId);

      createNotification(
        shopKey, null,
        'Out of Stock',
        `Item "${itemName}" is out of stock`,
        'OUT_OF_STOCK', 'ITEM', itemId
      );
    } else if (newQuantity <= LOW_STOCK_THRESHOLD) {
      // Only create if not already out-of-stock notified
      createNotification(
        shopKey, null,
        'Low Stock Alert',
        `Item "${itemName}" is running low (${newQuantity} remaining)`,
        'LOW_STOCK', 'ITEM', itemId
      );
    }
  } catch (err) {
    console.error('Stock notification error:', err.message);
  }
}

function createLowStockNotification(shopKey, itemName, itemId, quantity) {
  checkAndNotifyStock(shopKey, itemId, itemName, quantity);
}

// notifySaleCompleted — sends to ALL shop users, format "Rs. %.2f" matches Spring Boot
function createSaleNotification(shopKey, userId, cartId, total) {
  try {
    const db = getDb();
    const users = db.prepare('SELECT id FROM usr_user WHERE shop_key = ? AND enabled = 1').all(shopKey);
    const title = 'Sale completed';
    const description = `Sale #${cartId} completed for Rs. ${parseFloat(total).toFixed(2)}`;
    for (const u of users) {
      createNotification(shopKey, u.id, title, description, 'SALE_COMPLETED', 'CART', cartId);
    }
  } catch (err) {
    console.error('Sale notification error:', err.message);
  }
}

// Clear stock alerts when an item is restocked (called on edit-item quantity increase)
function clearStockAlertsForItem(shopKey, itemId) {
  try {
    const db = getDb();
    db.prepare(
      "DELETE FROM notification WHERE shop_key = ? AND reference_id = ? AND type IN ('LOW_STOCK','OUT_OF_STOCK')"
    ).run(shopKey, itemId);
  } catch (err) {
    console.error('Clear stock alert error:', err.message);
  }
}

module.exports = {
  createNotification,
  createLowStockNotification,
  checkAndNotifyStock,
  createSaleNotification,
  clearStockAlertsForItem,
  LOW_STOCK_THRESHOLD
};
