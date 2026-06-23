const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requirePermission } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const { LOW_STOCK_THRESHOLD } = require('../services/notificationService');
const router = express.Router();

// DashboardPeriod enum: TODAY("today"), WEEK("week"), MONTH("month") — matches Spring Boot exactly
const VALID_PERIODS = new Set(['today', 'week', 'month']);

function getDateRange(period) {
  const now = new Date();
  const normalized = (period || 'today').trim().toLowerCase();

  let start, end;
  switch (normalized) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      break;
    case 'week': {
      // Monday of current week
      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1;
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      break;
    }
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      break;
    default:
      throw new Error('Invalid dashboard period');
  }

  return { start: start.toISOString(), end: end.toISOString(), periodValue: normalized };
}

// Matches Spring Boot DashboardService.resolvePreviousRange exactly
function getPrevDateRange(period) {
  const now = new Date();
  let start, end;
  switch (period) {
    case 'today': {
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      start = yesterday.toISOString();
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      break;
    }
    case 'week': {
      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1;
      const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
      const prevWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
      const prevWeekEnd = new Date(prevWeekStart.getTime() + dayOfWeek * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
      start = prevWeekStart.toISOString();
      end = prevWeekEnd.toISOString();
      break;
    }
    case 'month': {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const day = Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate());
      const prevMonthEnd = new Date(now.getFullYear(), now.getMonth() - 1, day + 1);
      start = prevMonthStart.toISOString();
      end = prevMonthEnd.toISOString();
      break;
    }
    default:
      start = end = new Date().toISOString();
  }
  return { start, end };
}

router.get('/', authenticate, requirePermission('DASHBOARD'), (req, res) => {
  try {
    const { period = 'today' } = req.query;
    const db = getDb();
    const shopKey = req.user.shop_key;

    // Validate period — Spring Boot throws on unknown period
    const normalized = (period || 'today').trim().toLowerCase();
    if (!VALID_PERIODS.has(normalized)) {
      return errorResponse(res, 400, 'E001', 'Invalid dashboard period');
    }

    const { start, end, periodValue } = getDateRange(normalized);
    const { start: prevStart, end: prevEnd } = getPrevDateRange(normalized);

    // Single query for current period KPIs
    const periodStats = db.prepare(`
      SELECT
        COUNT(DISTINCT c.id) as total_transactions,
        COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as total_revenue,
        COALESCE(SUM(ci.quantity), 0) as total_items_sold,
        COUNT(DISTINCT c.customer_id) as unique_customers
      FROM cart c
      JOIN cart_item ci ON c.id = ci.cart_id
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
    `).get(shopKey, start, end);

    // Previous period for change calculation
    const prevStats = db.prepare(`
      SELECT
        COUNT(DISTINCT c.id) as total_transactions,
        COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as total_revenue,
        COUNT(DISTINCT c.customer_id) as unique_customers
      FROM cart c
      JOIN cart_item ci ON c.id = ci.cart_id
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
    `).get(shopKey, prevStart, prevEnd);

    // Open carts count
    const openCarts = db.prepare(
      'SELECT COUNT(*) as count FROM cart WHERE shop_key = ? AND status = 0'
    ).get(shopKey).count;

    // Sales trend — matches Spring Boot resolveTrendRange: TODAY/MONTH → last 7 days, WEEK → Monday to today
    const trendStart = (() => {
      if (normalized === 'week') return start; // already Monday
      // TODAY and MONTH: last 7 days (today.minusDays(6) → today)
      const d = new Date(); d.setDate(d.getDate() - 6);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    })();
    const trendEnd = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1).toISOString();

    const trendRows = db.prepare(`
      SELECT DATE(c.last_updated_date) as date,
        COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as revenue,
        COUNT(DISTINCT c.id) as transactions
      FROM cart c JOIN cart_item ci ON c.id = ci.cart_id
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
      GROUP BY DATE(c.last_updated_date)
      ORDER BY date ASC
    `).all(shopKey, trendStart, trendEnd);

    // fillTrendGaps — matches Spring Boot: every date between trendStart and trendEnd gets an entry
    const trendByDate = {};
    for (const row of trendRows) trendByDate[row.date] = row;
    const salesTrend = [];
    const trendCursor = new Date(trendStart);
    const trendEndDate = new Date(trendEnd); trendEndDate.setDate(trendEndDate.getDate() - 1);
    while (trendCursor <= trendEndDate) {
      const key = trendCursor.toISOString().split('T')[0];
      salesTrend.push(trendByDate[key] || { date: key, revenue: 0, transactions: 0 });
      trendCursor.setDate(trendCursor.getDate() + 1);
    }

    // Category share
    const categoryShare = db.prepare(`
      SELECT COALESCE(cat.name, 'Uncategorized') as category,
        COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as revenue,
        COUNT(DISTINCT c.id) as transactions
      FROM cart c
      JOIN cart_item ci ON c.id = ci.cart_id
      JOIN item i ON ci.item_id = i.id
      LEFT JOIN category cat ON i.category_id = cat.id
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
      GROUP BY cat.id
      ORDER BY revenue DESC
      LIMIT 10
    `).all(shopKey, start, end);

    // Payment method mix — COUNT(DISTINCT) to count carts not line items
    const paymentMix = db.prepare(`
      SELECT COALESCE(c.payment_method, 'CASH') as method,
        COUNT(DISTINCT c.id) as count,
        COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as revenue
      FROM cart c JOIN cart_item ci ON c.id = ci.cart_id
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
      GROUP BY c.payment_method
      ORDER BY revenue DESC
    `).all(shopKey, start, end);

    // Top products — include category name (matches Spring Boot DashboardTopProductDTO)
    const topProducts = db.prepare(`
      SELECT i.id, i.name, i.item_code,
        COALESCE(cat.name, 'Uncategorized') as category_name,
        COALESCE(SUM(ci.quantity), 0) as qty_sold,
        COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as revenue
      FROM cart c
      JOIN cart_item ci ON c.id = ci.cart_id
      JOIN item i ON ci.item_id = i.id
      LEFT JOIN category cat ON i.category_id = cat.id
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
      GROUP BY i.id
      ORDER BY qty_sold DESC
      LIMIT 5
    `).all(shopKey, start, end);

    // Recent sales — include item count (matches Spring Boot getRecentSales COUNT(ci.id))
    const recentSales = db.prepare(`
      SELECT c.id, c.last_updated_date, c.payment_method,
        cu.name as customer_name,
        cu.contact_number as customer_contact,
        COALESCE(SUM(ci.sold_price * ci.quantity - ci.discount), 0) as total,
        COUNT(ci.id) as item_count
      FROM cart c
      LEFT JOIN customer cu ON c.customer_id = cu.id
      JOIN cart_item ci ON c.id = ci.cart_id
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
      GROUP BY c.id
      ORDER BY c.last_updated_date DESC
      LIMIT 5
    `).all(shopKey, start, end);

    // Low stock — threshold 10 matches Spring Boot
    const lowStockItems = db.prepare(`
      SELECT id, name, item_code, quantity FROM item
      WHERE shop_key = ? AND quantity <= ?
      ORDER BY quantity ASC
      LIMIT 10
    `).all(shopKey, LOW_STOCK_THRESHOLD).slice(0, 5);

    // Peak hour — hour with most completed carts in current period
    const peakHourRow = db.prepare(`
      SELECT strftime('%H', c.last_updated_date) as hour, COUNT(*) as cnt
      FROM cart c
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
      GROUP BY hour ORDER BY cnt DESC LIMIT 1
    `).get(shopKey, start, end);
    // Spring Boot formatHourRange: "HH:00 – HH:00" (24hr, e.g. "14:00 – 15:00")
    let peakHourLabel = null;
    if (peakHourRow) {
      const h = parseInt(peakHourRow.hour);
      const next = (h + 1) % 24;
      peakHourLabel = `${String(h).padStart(2,'0')}:00 – ${String(next).padStart(2,'0')}:00`;
    } else {
      peakHourLabel = '—'; // "—" matches Spring Boot's null case return "—"
    }

    // Active customers — distinct customers who made purchases in period
    const activeCustomers = db.prepare(`
      SELECT COUNT(DISTINCT c.customer_id) as cnt
      FROM cart c
      WHERE c.shop_key = ? AND c.status = 1
      AND c.last_updated_date >= ? AND c.last_updated_date < ?
      AND c.customer_id IS NOT NULL
    `).get(shopKey, start, end).cnt;

    const calcChange = (current, prev) => {
      if (!prev || prev === 0) return current > 0 ? 100 : 0;
      return parseFloat(((current - prev) / prev * 100).toFixed(1));
    };

    const avgOrderValue = periodStats.total_transactions > 0
      ? Math.round((periodStats.total_revenue / periodStats.total_transactions) * 100) / 100
      : 0;

    // DashboardResponseDTO — exact Spring Boot field names
    return successResponse(res, {
      status: 'SUCCESS',
      period: periodValue,
      kpis: [
        { id: 'sales',     value: Math.round(periodStats.total_revenue * 100) / 100,    changePercent: calcChange(periodStats.total_revenue, prevStats.total_revenue) },
        { id: 'orders',    value: periodStats.total_transactions,                        changePercent: calcChange(periodStats.total_transactions, prevStats.total_transactions) },
        { id: 'avg',       value: avgOrderValue, changePercent: calcChange(avgOrderValue, prevStats.total_transactions > 0 ? prevStats.total_revenue / prevStats.total_transactions : 0) },
        { id: 'customers', value: activeCustomers, changePercent: calcChange(activeCustomers, prevStats.unique_customers || 0) }
      ],
      // DashboardTrendPointDTO: { date, sales, orders }
      salesTrend: salesTrend.map(p => ({ date: p.date, sales: p.revenue, orders: p.transactions })),
      // DashboardCategoryShareDTO: { name, amount }
      categoryShare: categoryShare.map(c => ({ name: c.category, amount: c.revenue })),
      // DashboardPaymentSliceDTO: { method, percent } — percent is revenue-based (matches Spring Boot getPaymentMix)
      payments: (() => {
        const totalRevenue = paymentMix.reduce((s, p) => s + p.revenue, 0) || 1;
        return paymentMix.map(p => ({ method: p.method, percent: Math.round((p.revenue / totalRevenue) * 1000) / 10 }));
      })(),
      // "peakHour" not "peakHourLabel"
      peakHour: peakHourLabel,
      // DashboardTopProductDTO: { code, name, category, sold, revenue } — category is actual name
      topProducts: topProducts.map(p => ({ code: p.item_code, name: p.name, category: p.category_name, sold: p.qty_sold, revenue: p.revenue })),
      // DashboardRecentSaleDTO — customer label: contact first, then name, then "Walk-in"
      // Matches Spring Boot: COALESCE(NULLIF(TRIM(cu.contact),''), NULLIF(TRIM(cu.name),''), 'Walk-in')
      recentSales: recentSales.map(s => ({
        cartId: s.id,
        completedAt: s.last_updated_date,
        customer: (s.customer_contact && s.customer_contact.trim()) || (s.customer_name && s.customer_name.trim()) || 'Walk-in',
        items: s.item_count,
        total: s.total,
        paymentMethod: s.payment_method
      })),
      // DashboardLowStockDTO: { code, name, stock } — field name "lowStock" not "lowStockItems"
      lowStock: lowStockItems.map(i => ({ code: i.item_code, name: i.name, stock: i.quantity })),
      openCarts,
      activeCustomers
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
