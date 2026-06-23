const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// SSE client registry: shopKey -> Set<res>
const shopClients = new Map();
const SSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — matches Spring Boot InventoryEventService

function getClients(shopKey) {
  if (!shopClients.has(shopKey)) shopClients.set(shopKey, new Set());
  return shopClients.get(shopKey);
}

function broadcast(shopKey, eventType, data) {
  const clients = shopClients.get(shopKey);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// GET /inventory — SSE stream for real-time inventory events
router.get('/inventory', authenticate, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const shopKey = req.user.shop_key;
  const clients = getClients(shopKey);
  clients.add(res);

  // Send initial connection confirmation — matches Spring Boot: name="connected", data={"status":"ok"}
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'ok' })}\n\n`);

  // Auto-close after 5 minutes — client should reconnect
  const timeout = setTimeout(() => {
    clients.delete(res);
    res.end();
  }, SSE_TIMEOUT_MS);

  req.on('close', () => {
    clearTimeout(timeout);
    clients.delete(res);
  });
});

module.exports = { router, broadcast };
