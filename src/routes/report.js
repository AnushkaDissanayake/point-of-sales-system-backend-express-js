const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requirePermission } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { paginatedResponse } = require('../utils/pagination');

const router = express.Router();

router.get('/generate', authenticate, requirePermission('REPORT'), (req, res) => {
  try {
    const { reportType, fromDate, toDate, page = 1, size = 50 } = req.query;
    if (!reportType) return errorResponse(res, 400, 'E002', 'reportType required');

    // INVENTORY_STOCK doesn't require dates — matches Spring Boot
    const isInventory = reportType.toUpperCase() === 'INVENTORY_STOCK';
    if (!isInventory) {
      if (!fromDate || !toDate) return errorResponse(res, 400, 'E002', 'From date and to date are required');
    }

    const start = new Date(fromDate || new Date().toISOString().split('T')[0]);
    const end = new Date(toDate || new Date().toISOString().split('T')[0]);
    end.setDate(end.getDate() + 1);

    if (!isInventory) {
      if (end <= start) return errorResponse(res, 400, 'E001', 'To date must be on or after from date');
      const diffDays = (end - start) / (1000 * 60 * 60 * 24);
      if (diffDays > 366) return errorResponse(res, 400, 'E001', 'Date range cannot exceed 366 days. Choose a shorter period.');
    }

    const db = getDb();
    const shopKey = req.user.shop_key;
    const startStr = start.toISOString();
    const endStr = end.toISOString();

    // ReportGenerateResponseDTO: { status, meta, summary?, rows?, products?, salesDetail?, inventory? }
    const meta = {
      reportType: reportType.toUpperCase(),
      fromDate: fromDate || new Date().toISOString().split('T')[0],
      toDate: toDate || new Date().toISOString().split('T')[0],
      generatedAt: Date.now()
    };
    const response = { status: 'SUCCESS', meta };

    switch (reportType.toUpperCase()) {
      case 'SALES_SUMMARY': {
        // SalesSummaryDTO: { totalRevenue, orderCount, avgOrderValue, totalItemsSold, totalDiscount }
        response.summary = db.prepare(`
          SELECT COUNT(DISTINCT c.id) as orderCount,
            COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as totalRevenue,
            COALESCE(SUM(ci.quantity), 0) as totalItemsSold,
            COALESCE(SUM(ci.discount), 0) as totalDiscount,
            COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount) / NULLIF(COUNT(DISTINCT c.id), 0), 0) as avgOrderValue
          FROM cart c JOIN cart_item ci ON c.id = ci.cart_id
          WHERE c.shop_key = ? AND c.status = 1
          AND c.last_updated_date >= ? AND c.last_updated_date < ?
        `).get(shopKey, startStr, endStr);
        break;
      }

      case 'SALES_BY_CATEGORY': {
        // ReportRowDTO: { label, subLabel, revenue, quantity, orderCount }
        const raw = db.prepare(`
          SELECT COALESCE(cat.name, 'Uncategorized') as category,
            COUNT(DISTINCT c.id) as transactions,
            COALESCE(SUM(ci.quantity), 0) as items_sold,
            COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as revenue
          FROM cart c JOIN cart_item ci ON c.id = ci.cart_id JOIN item i ON ci.item_id = i.id
          LEFT JOIN category cat ON i.category_id = cat.id
          WHERE c.shop_key = ? AND c.status = 1
          AND c.last_updated_date >= ? AND c.last_updated_date < ?
          GROUP BY cat.name ORDER BY revenue DESC
        `).all(shopKey, startStr, endStr);
        response.rows = raw.map(r => ({ label: r.category, subLabel: '', revenue: r.revenue, quantity: r.items_sold, orderCount: r.transactions }));
        break;
      }

      case 'SALES_BY_PAYMENT': {
        const raw = db.prepare(`
          SELECT COALESCE(c.payment_method, 'cash') as payment_method,
            COUNT(DISTINCT c.id) as transactions,
            COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as revenue
          FROM cart c JOIN cart_item ci ON c.id = ci.cart_id
          WHERE c.shop_key = ? AND c.status = 1
          AND c.last_updated_date >= ? AND c.last_updated_date < ?
          GROUP BY c.payment_method ORDER BY revenue DESC
        `).all(shopKey, startStr, endStr);
        response.rows = raw.map(r => ({ label: r.payment_method, subLabel: '', revenue: r.revenue, quantity: 0, orderCount: r.transactions }));
        break;
      }

      case 'TOP_PRODUCTS': {
        // TopProductRowDTO: { itemCode, itemName, quantitySold, revenue }
        const raw = db.prepare(`
          SELECT i.item_code, i.name,
            COALESCE(SUM(ci.quantity), 0) as qty_sold,
            COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as revenue
          FROM cart c JOIN cart_item ci ON c.id = ci.cart_id JOIN item i ON ci.item_id = i.id
          WHERE c.shop_key = ? AND c.status = 1
          AND c.last_updated_date >= ? AND c.last_updated_date < ?
          GROUP BY i.id ORDER BY qty_sold DESC LIMIT 25
        `).all(shopKey, startStr, endStr);
        response.products = raw.map(r => ({ itemCode: r.item_code, itemName: r.name, quantitySold: r.qty_sold, revenue: r.revenue }));
        break;
      }

      case 'SALES_BY_CASHIER': {
        const raw = db.prepare(`
          SELECT COALESCE(u.user_name, 'Unknown') as cashier,
            COUNT(DISTINCT c.id) as transactions,
            COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as revenue
          FROM cart c JOIN cart_item ci ON c.id = ci.cart_id
          LEFT JOIN usr_user u ON c.sold_by = u.id
          WHERE c.shop_key = ? AND c.status = 1
          AND c.last_updated_date >= ? AND c.last_updated_date < ?
          GROUP BY c.sold_by ORDER BY revenue DESC
        `).all(shopKey, startStr, endStr);
        response.rows = raw.map(r => ({ label: r.cashier, subLabel: '', revenue: r.revenue, quantity: 0, orderCount: r.transactions }));
        break;
      }

      case 'SALES_DETAIL': {
        // SalesDetailRowDTO: { cartId, completedDate, customerName, customerContact, paymentMethod, cashierName, itemCount, totalAmount }
        const safeSize = Math.min(Math.max(parseInt(size) || 50, 1), 100);
        const safePage = Math.max(parseInt(page) || 1, 1);
        const offset = (safePage - 1) * safeSize;
        const items = db.prepare(`
          SELECT c.id as cartId, c.last_updated_date as completedDate,
            cu.name as customerName, cu.contact_number as customerContact,
            c.payment_method as paymentMethod, u.user_name as cashierName,
            COUNT(ci.id) as itemCount,
            ROUND(COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0), 2) as totalAmount
          FROM cart c LEFT JOIN customer cu ON c.customer_id = cu.id
          LEFT JOIN usr_user u ON c.sold_by = u.id
          LEFT JOIN cart_item ci ON c.id = ci.cart_id
          WHERE c.shop_key = ? AND c.status = 1
          AND c.last_updated_date >= ? AND c.last_updated_date < ?
          GROUP BY c.id ORDER BY c.last_updated_date DESC LIMIT ? OFFSET ?
        `).all(shopKey, startStr, endStr, safeSize, offset);
        const total = db.prepare(`SELECT COUNT(DISTINCT c.id) as count FROM cart c WHERE c.shop_key = ? AND c.status = 1 AND c.last_updated_date >= ? AND c.last_updated_date < ?`).get(shopKey, startStr, endStr).count;
        const mappedItems = items.map(item => ({
          ...item,
          completedDate: item.completedDate ? item.completedDate.replace(' ', 'T').replace('Z', '') : null
        }));
        // Spring Boot Page.getNumber() is 0-based
        response.salesDetail = paginatedResponse(mappedItems, total, safePage - 1, safeSize);
        break;
      }

      case 'INVENTORY_STOCK': {
        // InventoryStockRowDTO: { itemCode, itemName, categoryName, quantity, sellPrice, stockValue }
        const raw = db.prepare(`
          SELECT i.item_code, i.name, i.quantity, i.price, i.buying_price,
            COALESCE(cat.name, 'Uncategorized') as category_name
          FROM item i LEFT JOIN category cat ON i.category_id = cat.id
          WHERE i.shop_key = ? ORDER BY i.name
        `).all(shopKey);
        response.inventory = raw.map(r => ({
          itemCode: r.item_code,
          itemName: r.name,
          categoryName: r.category_name,
          quantity: r.quantity,
          sellPrice: r.price,
          stockValue: Math.round(r.quantity * r.buying_price * 100) / 100
        }));
        break;
      }

      default:
        return errorResponse(res, 400, 'E001', 'Invalid report type');
    }

    return successResponse(res, response);
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
