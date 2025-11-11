// index.js — Pay2Pee Backend (Firestore + Stripe + Connect)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

// Firebase Admin singleton (lives at repo root)
const { admin, firestore } = require('./firebase-admin');

const app = express();

// ---------- Helper: normalize route exports (CJS/ESM/{ router }) ----------
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

// ---------- Stripe webhooks (RAW body FIRST) ----------
app.use('/api/webhooks/stripe', asRouter(require('./routes/stripeWebhooksRoutes')));
app.use('/stripe-webhooks',      asRouter(require('./routes/stripeWebhooksRoutes')));

// ---------- Body parsers (AFTER webhooks) ----------
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

// ---------- API routes (all under ./routes) ----------
app.use('/api/auth',          asRouter(require('./routes/auth')));
app.use('/api/users',         asRouter(require('./routes/users')));
app.use('/api/partner',       asRouter(require('./routes/partnerRoutes'))); // matches frontend calls
app.use('/api/locations',     asRouter(require('./routes/locationRoutes')));
app.use('/api/bathrooms',     asRouter(require('./routes/bathroomImageRoutes')));
app.use('/api/subscriptions', asRouter(require('./routes/subscriptions')));
app.use('/api/payments',      asRouter(require('./routes/paymentsRoutes')));

// If/when you add it:
// app.use('/api/connect',       asRouter(require('./routes/connectRoutes')));

// ---------- Optionally serve client build (if not using Firebase Hosting) ----------
if (process.env.NODE_ENV === 'production' && process.env.SERVE_CLIENT === 'true') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

// ---------- 404 + Error handlers ----------
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

