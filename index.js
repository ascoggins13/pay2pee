// index.js — Pay2Pee Backend (Firestore + Stripe + Connect)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

// Firebase Admin (singleton)
const { admin, firestore } = require('./firebase-admin');

const app = express();

// ---------- Helper to normalize route exports ----------
/**
 * Accepts:
 *   - CommonJS: module.exports = router
 *   - ESM default: export default router
 *   - Named: module.exports = { router }
 */
const asRouter = (mod) => (mod && (mod.router || mod.default)) || mod;

// ---------- Core middleware ----------
app.set('trust proxy', 1);
app.use(
  cors({
    origin: ['https://pay2pee.app', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ---------- Stripe webhook (RAW) FIRST ----------
app.use(
  '/api/webhooks/stripe',
  asRouter(require('./server/routes/stripeWebhooksRoutes'))
);
// Optional legacy alias:
app.use(
  '/stripe-webhooks',
  asRouter(require('./server/routes/stripeWebhooksRoutes'))
);

// ---------- JSON parsers (after webhook) ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- Healthcheck ----------
app.get('/api/healthcheck', async (_req, res) => {
  try {
    await firestore.collection('_meta').limit(1).get();
    res.json({
      status: 'healthy',
      serverTime: new Date().toISOString(),
      dbStatus: 'connected',
      firebaseStatus: admin.apps.length > 0 ? 'connected' : 'disconnected',
    });
  } catch {
    res.json({
      status: 'degraded',
      serverTime: new Date().toISOString(),
      dbStatus: 'unreachable',
      firebaseStatus: admin.apps.length > 0 ? 'connected' : 'disconnected',
    });
  }
});

// ---------- API routes (under server/routes) ----------
app.use('/api/auth',          asRouter(require('./server/routes/auth')));
app.use('/api/users',         asRouter(require('./server/routes/users')));

// Match your frontend which calls /api/partner/...
app.use('/api/partner',       asRouter(require('./server/routes/partnerRoutes')));

app.use('/api/locations',     asRouter(require('./server/routes/locationRoutes')));
app.use('/api/bathrooms',     asRouter(require('./server/routes/bathroomImageRoutes')));
app.use('/api/subscriptions', asRouter(require('./server/routes/subscriptions')));
app.use('/api/payments',      asRouter(require('./server/routes/paymentsRoutes')));

// If/when you add it:
// app.use('/api/connect',       asRouter(require('./server/routes/connectRoutes')));

// ---------- Optional: serve client ----------
if (process.env.NODE_ENV === 'production' && process.env.SERVE_CLIENT === 'true') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

// ---------- 404 / Error handlers ----------
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));
app.use((err, _req, res, _next) => {
  console.error('⚠️ Server Error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Server error',
  });
});

// ---------- Start ----------
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Pay2Pee server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// ---------- Graceful shutdown ----------
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => console.log('Process terminated'));
});
