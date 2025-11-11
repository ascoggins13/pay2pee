// index.js — Pay2Pee Backend (Firestore + Stripe + Connect)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

// Firebase Admin singleton (lives at repo root)
const { admin, firestore } = require('./firebase-admin');

const app = express();

// ---------- helpers ----------
const asRouter = (mod) => (mod && (mod.router || mod.default)) || mod;

function pickRoute(label, relPath) {
  const abs = path.join(__dirname, relPath);
  const exists = fs.existsSync(abs) || fs.existsSync(abs + '.js');
  if (!exists) {
    console.error(`[route:${label}] NOT FOUND at ${relPath}`);
    throw new Error(`Missing route file for ${label}: ${relPath}`);
  }
  const raw = require(abs);
  const picked = asRouter(raw);
  console.log(
    `[route:${label}] from ${relPath} -> rawType=${typeof raw}` +
    (raw && typeof raw === 'object' ? ` rawKeys=[${Object.keys(raw)}]` : '') +
    ` pickedType=${typeof picked}`
  );
  return picked;
}

// ---------- core middleware ----------
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
const stripeWebhooks = pickRoute('webhooks', './routes/stripeWebhooksRoutes');
app.use('/api/webhooks/stripe', stripeWebhooks);
app.use('/stripe-webhooks',      stripeWebhooks);

// ---------- Body parsers (AFTER webhooks) ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- healthcheck ----------
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

// ---------- API routes ----------
app.use('/api/auth',          pickRoute('auth',          './routes/auth'));
app.use('/api/users',         pickRoute('users',         './routes/users'));
app.use('/api/partner',       pickRoute('partner',       './routes/partnerRoutes'));
app.use('/api/locations',     pickRoute('locations',     './routes/locationRoutes'));
app.use('/api/bathrooms',     pickRoute('bathrooms',     './routes/bathroomImageRoutes'));
app.use('/api/subscriptions', pickRoute('subscriptions', './routes/subscriptions'));
app.use('/api/payments',      pickRoute('payments',      './routes/paymentsRoutes'));
// If/when you add connect:
// app.use('/api/connect',    pickRoute('connect',       './routes/connectRoutes'));

// ---------- serve client (optional) ----------
if (process.env.NODE_ENV === 'production' && process.env.SERVE_CLIENT === 'true') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

// ---------- 404 + error handlers ----------
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));

app.use((err, _req, res, _next) => {
  console.error('⚠️ Server Error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Server error',
  });
});

// ---------- start ----------
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Pay2Pee server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🟡 Node ${process.version} — consider upgrading to 20.x in package.json "engines"`);
});

// ---------- graceful shutdown ----------
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => console.log('Process terminated'));
});
