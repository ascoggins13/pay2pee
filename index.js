// index.js — Pay2Pee Backend (Firestore + Stripe + Connect)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

// Our centralized firebase helper
const {
  admin,
  firestore,
  bucket,
  getFirebaseConfigInfo,
  firestoreSmokeTest,
} = require('./firebase-admin');

const app = express();

/* -------------------- Core middleware -------------------- */
app.set('trust proxy', 1);

const allowedOrigins = [
  'https://pay2pee.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// Apply CORS to all routes
app.use(cors(corsOptions));
// Ensure preflight (OPTIONS) also gets CORS headers
app.options('*', cors(corsOptions));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

/* ---------------- Stripe webhooks (RAW FIRST) ------------- */
const stripeWebhooks = require('./routes/stripeWebhooksRoutes');
app.use('/api/webhooks/stripe', stripeWebhooks);
app.use('/stripe-webhooks', stripeWebhooks); // legacy alias if Stripe is pointed here

/* --------------- Body parsers (AFTER webhooks) ------------ */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const connectRoutes = require('./routes/connectRoutes');
app.use('/api/connect', connectRoutes);

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
  } catch (err) {
    console.error('Healthcheck Firestore error:', err);
    res.json({
      status: 'degraded',
      serverTime: new Date().toISOString(),
      dbStatus: 'unreachable',
      firebaseStatus: admin.apps.length ? 'connected' : 'disconnected',
    });
  }
});

/* ----------------- Debug endpoints ------------------------ */

// Shows projectId, databaseId, bucket, and credential source
app.get('/api/_debug/firebase', (_req, res) => {
  res.json(getFirebaseConfigInfo());
});

// Actually touches Firestore and returns ok / error
app.get('/api/_debug/fs-smoketest', async (_req, res) => {
  const result = await firestoreSmokeTest();
  res.json(result);
});

/* ------------------------ Routes -------------------------- */

// Simple routers (each must export `module.exports = router`)
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/locations', require('./routes/locationRoutes'));
app.use('/api/bathrooms', require('./routes/bathroomImageRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/payments', require('./routes/paymentsRoutes'));
app.use('/api/guest', require('./routes/guestVisitsRoutes'));

// Partner routes — file exports { partnerRouter, hostRouter } OR a single router
(() => {
  const partnerModule = require('./routes/partnerRoutes');

  if (partnerModule && (partnerModule.partnerRouter || partnerModule.hostRouter)) {
    if (partnerModule.partnerRouter) {
      app.use('/api/partner', partnerModule.partnerRouter);
    }
    if (partnerModule.hostRouter) {
      app.use('/api/host', partnerModule.hostRouter);
    }
  } else {
    // fallback if it’s just a single router export
    app.use('/api/partner', partnerModule);
  }

  // Mount analytics under the same /api/partner namespace
  app.use('/api/partner', require('./routes/partnerAnalytics'));
})();

// app.use('/api/connect', require('./routes/connectRoutes'));

/* --------------- Serve client (optional) ------------------ */
if (process.env.NODE_ENV === 'production' && process.env.SERVE_CLIENT === 'true') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

/* ---------------- 404 + Error handlers -------------------- */
app.use((req, res) =>
  res.status(404).json({ success: false, error: 'Endpoint not found' })
);

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
