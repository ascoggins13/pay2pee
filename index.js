// index.js – Pay2Pee Backend (Firestore + Stripe)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const morgan = require('morgan');
const { admin, firestore } = require('./firebase-admin');

const app = express();

// ---------- CORS / proxy / logs ----------
app.use(cors({
  origin: ['https://pay2pee.app', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.set('trust proxy', 1);
app.use(morgan('dev'));

// ---------- STRIPE WEBHOOK (RAW) — mount BEFORE express.json() ----------
app.use('/api/webhooks/stripe', require('./routes/stripeWebhooksRoutes'));

// ---------- JSON body parsers (after webhook) ----------
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
      firebaseStatus: admin.apps.length > 0 ? 'connected' : 'disconnected'
    });
  } catch {
    res.json({
      status: 'degraded',
      serverTime: new Date().toISOString(),
      dbStatus: 'unreachable',
      firebaseStatus: admin.apps.length > 0 ? 'connected' : 'disconnected'
    });
  }
});

// ---------- API routes ----------
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/partners',    require('./routes/partnerRoutes'));      // keep plural to match your file
app.use('/api/locations',   require('./routes/locationRoutes'));
app.use('/api/bathrooms',   require('./routes/bathroomImageRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/payments',    require('./routes/paymentsRoutes'));     // includes /prices, /subscriptions, /one-time, /portal

// ---------- Static frontend (optional if using Firebase Hosting) ----------
if (process.env.NODE_ENV === 'production' && process.env.SERVE_CLIENT === 'true') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

// ---------- 404 / error handlers ----------
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));
app.use((err, _req, res, _next) => {
  console.error('⚠️ Server Error:', err);
  res.status(500).json({ success: false, error: process.env.NODE_ENV === 'development' ? err.message : 'Server error' });
});

// ---------- Start ----------
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Pay2Pee server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => console.log('Process terminated'));
});
