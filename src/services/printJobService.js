const { broadcast } = require('../routes/events');

/**
 * Snapshots everything a receipt template needs (shop identity, customer, line
 * items, totals, payment info) at the moment a sale completes. This is stored
 * as-is on the print job so a later edit to shop settings, or the item catalog,
 * never changes what actually gets printed for a past sale.
 */
function buildReceiptPayload(db, shopKey, cartId, sale) {
  const shop = db.prepare('SELECT shop_name, shop_logo, address, mobile, mobile2 FROM shop_detail WHERE shop_key = ?').get(shopKey);
  const cart = db.prepare('SELECT customer_id FROM cart WHERE id = ?').get(cartId);
  const customer = cart && cart.customer_id
    ? db.prepare('SELECT name, contact_number FROM customer WHERE id = ?').get(cart.customer_id)
    : null;
  const rawItems = db.prepare(`
    SELECT ci.quantity, ci.sold_price, ci.discount, i.name as item_name, i.item_code, i.unit
    FROM cart_item ci
    JOIN item i ON ci.item_id = i.id
    WHERE ci.cart_id = ?
  `).all(cartId);

  const subtotal = rawItems.reduce((sum, r) => sum + r.sold_price * r.quantity, 0);
  const totalDiscount = rawItems.reduce((sum, r) => sum + (r.discount || 0), 0);

  return {
    cartId,
    soldAt: new Date().toISOString(),
    shopName: shop?.shop_name || '',
    shopLogo: shop?.shop_logo || null,
    shopAddress: shop?.address || '',
    shopMobile: shop?.mobile || '',
    shopMobile2: shop?.mobile2 || '',
    cashierName: sale.cashierName || '',
    customer: {
      name: customer?.name || '',
      contact: customer?.contact_number || '',
      notes: '',
    },
    lines: rawItems.map((r) => ({
      itemCode: r.item_code,
      name: r.item_name,
      price: r.sold_price,
      quantity: r.quantity,
      discount: r.discount || 0,
      unit: r.unit || 'qty',
    })),
    subtotal: Math.round(subtotal * 100) / 100,
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    grandTotal: sale.grandTotal,
    amountPaid: sale.amountPaid,
    changeDue: sale.changeDue,
    paymentMethod: sale.paymentMethod,
    paymentReference: sale.paymentReference || undefined,
  };
}

/**
 * Queues a receipt for remote printing and pushes it live over SSE. If the
 * printing PC isn't connected right now, the row just sits 'pending' -- it
 * calls GET /print-jobs/pending on reconnect and catches up, so a dropped
 * connection never means a lost receipt.
 */
function createPrintJob(db, shopKey, cartId, sale) {
  const receipt = buildReceiptPayload(db, shopKey, cartId, sale);
  const result = db.prepare(
    `INSERT INTO print_job (shop_key, cart_id, status, receipt_json) VALUES (?, ?, 'pending', ?)`
  ).run(shopKey, cartId, JSON.stringify(receipt));

  const job = { id: result.lastInsertRowid, cartId, receipt };
  broadcast(shopKey, 'PRINT_JOB_CREATED', job);
  return job;
}

module.exports = { createPrintJob };
