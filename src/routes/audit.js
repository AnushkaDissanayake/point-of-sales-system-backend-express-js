const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();

// GET / — matches Spring Boot AuditController (1-based paging, default page=1 size=25, max size=100)
router.get('/', authenticate, requireAdmin, (req, res) => {
  try {
    const { page = 1, size = 25, action, actorUsername, entityType } = req.query;
    const db = getDb();
    const shopKey = req.user.shop_key;

    const safePage = Math.max(parseInt(page) || 1, 1);
    const safeSize = Math.min(Math.max(parseInt(size) || 25, 1), 100);
    const offset = (safePage - 1) * safeSize;

    let where = 'WHERE shop_key = ?';
    const params = [shopKey];

    if (action) { where += ' AND action = ?'; params.push(action); }
    if (actorUsername) { where += ' AND actor_username LIKE ?'; params.push(`%${actorUsername}%`); }
    if (entityType) { where += ' AND entity_type = ?'; params.push(entityType); }

    const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY created_date DESC LIMIT ? OFFSET ?`).all(...params, safeSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`).get(...params).count;
    const totalPages = Math.ceil(total / safeSize);

    // Map to Spring Boot AuditLogDTO camelCase field names
    const items = rows.map(r => ({
      id: r.id,
      createdDate: r.created_date ? r.created_date.replace(' ', 'T').replace('Z', '') : null,
      actorUsername: r.actor_username,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityReference: r.entity_reference,
      status: r.status,
      summary: r.summary,
      failReason: r.fail_reason,
      httpMethod: r.http_method,
      requestPath: r.request_path,
      requestDetails: r.request_details,
      clientIp: r.client_ip
    }));

    // AuditLogListResponseDTO { status, auditLogs: Page } — number is 0-based (Spring Page.getNumber())
    return successResponse(res, {
      status: 'SUCCESS',
      auditLogs: {
        content: items,
        totalElements: total,
        totalPages,
        number: safePage - 1,
        size: safeSize
      }
    });
  } catch (err) {
    return errorResponse(res, 500, 'E000', err.message);
  }
});

module.exports = router;
