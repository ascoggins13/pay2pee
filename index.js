// index.js — Pay2Pee Backend (Firestore + Stripe + Connect + Debug)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const { admin, firestore, resolvedInfo } = require('./firebase-admin');

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
// Your stripe webhooks router should export a router that uses express.raw({type:'application/json'})
// inside the file for the POST handler. Mount it BEFORE json body-parsers.
const stripeWebhooks = require('./routes/stripeWebhooksRoutes');
app.use('/api/webhooks/stripe', stripeWebhooks);
// Legacy alias if you’ve ever pointed Stripe here:
app.use('/stripe-webhooks', stripeWebhooks);

/* --------------- Body parsers (AFTER webhooks) ------------ */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ---------------------- Healthcheck ----------------------- */
app.get('/api/healthcheck', async (_req, res) => {
  try {
    // very light touch call
    await firestore.collection('_meta').limit(1).get();
    res.json({
      status: 'healthy',
      serverTime: new Date().toISOString(),
      dbStatus: 'connected',
      firebaseStatus: admin.apps.length ? 'connected' : 'disconnected',
    });
  } catch (e) {
    res.status(200).json({
      status: 'degraded',
      serverTime: new Date().toISOString(),
      dbStatus: 'unreachable',
      firebaseStatus: admin.apps.length ? 'connected' : 'disconnected',
      note: e?.message,
    });
  }
});

/* ----------------------- Debug ---------------------------- */
// Shows what project/bucket the Admin SDK actually resolved to
app.get('/api/_debug/firebase', (_req, res) => {
  res.json(resolvedInfo());
});

// Firestore smoke test: write + read back a tiny doc
app.get('/api/_debug/fs-smoketest', async (_req, res) => {
  try {
    const col = firestore.collection('_smoke');
    const docRef = col.doc('ping');
    await docRef.set({ ok: true, ts: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const snap = await docRef.get();
    res.json({ write: 'ok', read: snap.exists, data: snap.data() || null });
  } catch (e) {
    // If you see { error: 5 } here, it’s almost always a project/credentials mismatch.
    res.json({ error: e.code || 'unknown', message: e.message || String(e) });
  }
});

/* ------------------------ Routes -------------------------- */
// NOTE: All of these must export `module.exports = router`
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/locations',     require('./routes/locationRoutes'));
app.use('/api/bathrooms',     require('./routes/bathroomImageRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/payments',      require('./routes/paymentsRoutes'));

// partnerRoutes may export two routers: { partnerRouter, hostRouter }.
// This safely handles either shape.
(() => {
  const partnerModule = require('./routes/partnerRoutes');
  if (partnerModule && (partnerModule.partnerRouter || partnerModule.hostRouter)) {
    if (partnerModule.partnerRouter) app.use('/api/partner', partnerModule.partnerRouter);
    if (partnerModule.hostRouter)   app.use('/api/host', partnerModule.hostRouter);
  } else {
    app.use('/api/partner', partnerModule);
  }
})();

// If/when you add Stripe Connect user flows:
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
  const info = resolvedInfo();
  console.log(`🚀 Pay2Pee server running on port ${PORT}`);
  console.log(`🌐 Env: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🪪 Firebase project: ${info.resolvedProjectId}`);
  console.log(`🪣 Storage bucket:  ${info.storageBucket}`);
});

/* ------------------ Graceful shutdown --------------------- */
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => console.log('Process terminated'));
});
