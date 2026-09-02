const express = require('express');
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();

// Catch-up polling: returns every job still pending for this shop, oldest first,
// so a PC that reconnects after being offline prints in the original sale order.
router.get('/pending', authenticate, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, cart_id, receipt_json, created_date FROM print_job
       WHERE shop_key = ? AND status = 'pending'
       ORDER BY created_date ASC, id ASC
       LIMIT 50`
    ).all(req.user.shop_key);

    const printJobs = rows.map((row) => ({
      id: row.id,
      cartId: row.cart_id,
      receipt: JSON.parse(row.receipt_json),
      createdDate: row.created_date,
    }));
    return successResponse(res, { printJobs });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

// Idempotent on purpose: acking an already-printed (or unknown) job is not an error --
// avoids a race between the live SSE push and a catch-up poll double-completing the same job.
router.post('/:id/ack', authenticate, (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare('SELECT id FROM print_job WHERE id = ? AND shop_key = ?').get(req.params.id, req.user.shop_key);
    if (!job) return successResponse(res, null, 'Print job not found');

    db.prepare(
      `UPDATE print_job SET status = 'printed', printed_date = datetime('now', 'localtime') WHERE id = ? AND status = 'pending'`
    ).run(req.params.id);

    return successResponse(res, null, 'Print job acknowledged');
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
