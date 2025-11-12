// index.js — Pay2Pee Backend (Firestore + Stripe + Connect)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

// Shared Firebase Admin bootstrap (must export { admin, firestore })
const { admin, firestore } = require('./firebase-admin');

const app = express();

/* ───────────────────── Core middleware ───────────────────── */
app.set('trust proxy', 1);
app.use(
  cors({
    origin: [
      'https://pay2pee.app',
      'http://localhost:3000',
      'https://pay2pee.onrender.com', // helpful for quick tests
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

/* ─────────────── Stripe webhooks (RAW BODY FIRST) ───────────────
   IMPORTANT: The router you require here must consume raw body itself.
   Keep this BEFORE express.json() to avoid breaking signature verification.
*/
const stripeWebhooks = require('./routes/stripeWebhooksRoutes');
app.use('/api/webhooks/stripe', stripeWebhooks);
app.use('/stripe-webhooks', stripeWebhooks); // legacy alias if you ever pointed Stripe here

/* ────────────── Body parsers (AFTER webhooks) ────────────── */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ─────────────────────── Healthcheck ─────────────────────── */
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

/* ─────────────── Firebase debug endpoints (temp) ─────────────── */
app.get('/api/_debug/firebase', async (_req, res) => {
  try {
    const prj =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      (await admin.app().options.credential.getProjectId?.()) ||
      admin.app().options.projectId;

    res.json({
      resolvedProjectId: prj,
      storageBucket: admin.storage().bucket().name,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/api/_debug/fs-smoketest', async (_req, res) => {
  try {
    const ref = firestore.collection('_meta').doc('health');
    await ref.set({ ok: true, ts: new Date().toISOString() }, { merge: true });
    const snap = await ref.get();
    res.json({ write: 'ok', read: snap.exists, data: snap.data() });
  } catch (e) {
    console.error('🔥 fs-smoketest error:', e.code, e.message);
    res.status(500).json({ error: e.code || 'fs-error', message: e.message });
  }
});

/* ─────────────────────── API routes ─────────────────────── */
// Simple routers (export: module.exports = router)
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/locations',     require('./routes/locationRoutes'));
app.use('/api/bathrooms',     require('./routes/bathroomImageRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/payments',      require('./routes/paymentsRoutes'));

// Partner routes — file may export { partnerRouter, hostRouter } or a single router
(() => {
  const partnerModule = require('./routes/partnerRoutes');
  if (partnerModule && (partnerModule.partnerRouter || partnerModule.hostRouter)) {
    if (partnerModule.partnerRouter) app.use('/api/partner', partnerModule.partnerRouter);
    if (partnerModule.hostRouter) app.use('/api/host', partnerModule.hostRouter);
  } else {
    app.use('/api/partner', partnerModule);
  }
})();

// If/when you add Connect account onboarding/payments:
// app.use('/api/connect', require('./routes/connectRoutes'));

/* ─────────────── Serve client (optional) ───────────────
   Only if you are NOT hosting the client on Firebase Hosting.
*/
if (process.env.NODE_ENV === 'production' && process.env.SERVE_CLIENT === 'true') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

/* ───────────────── 404 + Error handlers ───────────────── */
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));

app.use((err, _req, res, _next) => {
  console.error('⚠️ Server Error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Server error',
  });
});

/* ─────────────────────── Start server ─────────────────────── */
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Pay2Pee server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

/* ──────────────────── Graceful shutdown ──────────────────── */
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => console.log('Process terminated'));
});
