require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeDatabase } = require('./config/database');
const { authenticate } = require('./middleware/auth');
const { enforceSubscription } = require('./middleware/subscription');
const { auditMiddleware } = require('./middleware/auditLog');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const itemRoutes = require('./routes/item');
const categoryRoutes = require('./routes/category');
const customerRoutes = require('./routes/customer');
const vendorRoutes = require('./routes/vendor');
const cartRoutes = require('./routes/cart');
const expressSaleRoutes = require('./routes/expressSale');
const dashboardRoutes = require('./routes/dashboard');
const reportRoutes = require('./routes/report');
const settingsRoutes = require('./routes/settings');
const auditRoutes = require('./routes/audit');
const notificationRoutes = require('./routes/notifications');
const subscriptionRoutes = require('./routes/subscription');
const mainRoutes = require('./routes/main');
const { router: eventsRouter } = require('./routes/events');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS — match Spring Boot config
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['*'],
  exposedHeaders: ['*']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve React frontend static files.
// In production (installed): frontend is at ../frontend relative to backend dir.
// In dev: not served here — Vite dev server handles it on port 5500.
const frontendDist = path.join(__dirname, '..', '..', 'frontend');
if (require('fs').existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
}

// Audit logging on all mutations (skips GET/OPTIONS internally)
app.use(auditMiddleware);

// Public routes — no auth required
app.use('/api/v1/auth', authRoutes);
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'UP', timestamp: new Date().toISOString(), service: 'AD SmartPOS Backend' });
});

// POST /backup — triggers the PowerShell backup script
app.post('/api/v1/backup', (req, res) => {
  const { spawn } = require('child_process');
  const BACKUP_SCRIPT = 'C:\\Program Files\\AD-SmartPOS-Express\\scripts\\backup.ps1';
  const timestamp = new Date().toISOString();
  try {
    const proc = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass', '-NonInteractive',
      '-File', BACKUP_SCRIPT, '-Action', 'Backup'
    ], { stdio: 'pipe' });
    const timer = setTimeout(() => {
      proc.kill();
      res.status(202).json({ status: 'TIMEOUT', message: 'Backup started but did not complete within timeout', timestamp });
    }, 5 * 60 * 1000);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) res.json({ status: 'SUCCESS', message: 'Backup completed successfully', timestamp });
      else res.status(500).json({ status: 'FAILED', exitCode: code, timestamp });
    });
    proc.on('error', err => { clearTimeout(timer); res.status(500).json({ status: 'ERROR', message: err.message, timestamp }); });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', message: err.message, timestamp });
  }
});

// Authenticated routes — subscription enforcement applied after auth
app.use('/api/v1/main', mainRoutes);
app.use('/api/v1/subscription', subscriptionRoutes);
app.use('/api/v1/events', eventsRouter);

// Subscription enforcement: returns 402 if subscription inactive
// Applied after auth middleware in each route, before business logic
app.use('/api/v1/user',         authenticate, enforceSubscription, userRoutes);
app.use('/api/v1/item',         authenticate, enforceSubscription, itemRoutes);
app.use('/api/v1/category',     authenticate, enforceSubscription, categoryRoutes);
app.use('/api/v1/customer',     authenticate, enforceSubscription, customerRoutes);
app.use('/api/v1/vendor',       authenticate, enforceSubscription, vendorRoutes);
app.use('/api/v1/cart',         authenticate, enforceSubscription, cartRoutes);
app.use('/api/v1/express-sale', authenticate, enforceSubscription, expressSaleRoutes);
app.use('/api/v1/dashboard',    authenticate, enforceSubscription, dashboardRoutes);
app.use('/api/v1/report',       authenticate, enforceSubscription, reportRoutes);
app.use('/api/v1/settings',     authenticate, enforceSubscription, settingsRoutes);
app.use('/api/v1/audit',        authenticate, enforceSubscription, auditRoutes);
app.use('/api/v1/notifications',authenticate, enforceSubscription, notificationRoutes);

// SPA fallback — serve index.html for any non-API GET request so React Router works
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexFile = path.join(__dirname, '..', '..', 'frontend', 'index.html');
  if (require('fs').existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    next();
  }
});

// 404 handler — only reached for unmatched API routes
app.use((req, res) => {
  res.status(404).json({ errorCode: 'E004', failReason: `Endpoint not found: ${req.method} ${req.path}` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ errorCode: 'E000', failReason: err.message });
});

try {
  initializeDatabase();
  const server = app.listen(PORT, () => {
    console.log(`POS Backend (Express.js + SQLite) running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
    
    // Start local network auto-discovery services
    try {
      const { startDiscovery } = require('./services/networkDiscoveryService');
      startDiscovery(PORT);
    } catch (discoveryErr) {
      console.error('Failed to start network discovery services:', discoveryErr);
    }
  });
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}

module.exports = app;
