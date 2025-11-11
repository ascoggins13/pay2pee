// index.js — Pay2Pee Backend (Firestore + Stripe + Connect)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const { admin, firestore } = require('./firebase-admin');

const app = express();

/* -------------------- Core middleware -------------------- */
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

/* ---------------- Stripe webhooks (RAW FIRST) ------------- */
const stripeWebhooks = require('./routes/stripeWebhooksRoutes');
app.use('/api/webhooks/stripe', stripeWebhooks);
app.use('/stripe-webhooks', stripeWebhooks); // legacy alias if needed

/* --------------- Body parsers (AFTER webhooks) ------------ */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ---------------------- Healthcheck ----------------------- */
app.get('/api/healthcheck', async (_req, res) => {
  try {
    await firestore.collection('_meta').limit(1).get();
    res.json({
      status: 'healthy',
      serverTime: new Date().toISOString(),
      dbStatus: 'connected',
      firebaseStatus: admin.apps.length ? 'connected' : 'disconnected',
    });
  } catch {
    res.json({
      status: 'degraded',
      serverTime: new Date().toISOString(),
      dbStatus: 'unreachable',
      firebaseStatus: admin.apps.length ? 'connected' : 'disconnected',
    });
  }
});

/* ------------------------ Routes -------------------------- */
// Simple routers (must export `module.exports = router`)
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/locations',     require('./routes/locationRoutes'));
app.use('/api/bathrooms',     require('./routes/bathroomImageRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/payments',      require('./routes/paymentsRoutes'));

// Partner routes — your file exports two routers: { partnerRouter, hostRouter }
(() => {
  const partnerModule = require('./routes/partnerRoutes');

  // If it exports both named routers:
  if (partnerModule && (partnerModule.partnerRouter || partnerModule.hostRouter)) {
    if (partnerModule.partnerRouter) {
      // Frontend hits /api/partner/*
      app.use('/api/partner', partnerModule.partnerRouter);
    }
    if (partnerModule.hostRouter) {
      // If your frontend calls /api/host/*, mount here:
      app.use('/api/host', partnerModule.hostRouter);
      // If you prefer under /api/partner/host/* instead, use:
      // app.use('/api/partner/host', partnerModule.hostRouter);
    }
  } else {
    // Fallback: if the file exports a single router
    app.use('/api/partner', partnerModule);
  }
})();

// If/when you add connect:
// app.use('/api/connect', require('./routes/connectRoutes'));

/* --------------- Serve client (optional) ------------------ */
if (process.env.NODE_ENV === 'production' && process.env.SERVE_CLIENT === 'true') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

/* ---------------- 404 + Error handlers -------------------- */
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));

app.use((err, _req, res, _next) => {
  console.error('⚠️ Server Error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Server error',
  });
});

/* -------------------- Start server ------------------------ */
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Pay2Pee server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

/* ------------------ Graceful shutdown --------------------- */
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => console.log('Process terminated'));
});
