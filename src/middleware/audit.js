const { getDb } = require('../config/database');

function auditLog(action, entityType, entityId, entityReference, summary, status = 'SUCCESS', failReason = null) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      try {
        const db = getDb();
        const user = req.user;
        const resolvedStatus = res.statusCode < 400 ? 'SUCCESS' : 'FAILED';
        const resolvedEntityId = typeof entityId === 'function' ? entityId(req, data) : entityId;
        const resolvedEntityRef = typeof entityReference === 'function' ? entityReference(req, data) : entityReference;
        const resolvedSummary = typeof summary === 'function' ? summary(req, data) : summary;

        db.prepare(`
          INSERT INTO audit_log (shop_key, actor_user_id, actor_username, action, entity_type, entity_id, entity_reference, status, summary, fail_reason, http_method, request_path, client_ip, user_agent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          user?.shop_key || null,
          user?.id || null,
          user?.user_name || null,
          action,
          entityType,
          resolvedEntityId ? String(resolvedEntityId) : null,
          resolvedEntityRef || null,
          resolvedStatus,
          resolvedSummary || null,
          failReason || null,
          req.method,
          req.path,
          req.ip || req.connection?.remoteAddress || null,
          req.headers['user-agent'] || null
        );
      } catch (err) {
        console.error('Audit log error:', err.message);
      }
      return originalJson(data);
    };
    next();
  };
}

module.exports = { auditLog };
