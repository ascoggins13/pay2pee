// index.js — Pay2Pee Backend (Express + Firestore + Stripe)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const app = express();

app.use(cors());
app.options('*', cors());




/* -------------------- BASIC MIDDLEWARE -------------------- */

app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1); // Render / proxies

/* ---------------------- API ROUTES ------------------------ */

// ✅ AUTH: this matches your original setup: routes/auth.js
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// LOCATIONS (guest map / nearby)
const locationRoutes = require('./routes/locationRoutes');
app.use('/api/locations', locationRoutes);

// PAYMENTS (Stripe checkout, MyPass, subscriptions)
const paymentsRoutes = require('./routes/paymentsRoutes');
app.use('/api/payments', paymentsRoutes);

// PARTNER / HOST (partner profile, visibility, analytics, payouts)
const partnerModule = require('./routes/partnerRoutes');
if (partnerModule.partnerRouter) {
  app.use('/api/partner', partnerModule.partnerRouter);
}
if (partnerModule.hostRouter) {
  app.use('/api/host', partnerModule.hostRouter);
}

const notificationsRoutes = require('./routes/notificationsRoutes');
app.use('/api/notifications', notificationsRoutes);

const chatRoutes = require('./routes/chatRoutes');

app.use('/api/chat', chatRoutes);

const leadsRoutes = require('./routes/leadsRoutes');

/* ---------------------- HEALTHCHECK ----------------------- */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  });
});

/* --------------- Serve client (production) ---------------- */

if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.join(__dirname, 'client', 'build');
  app.use(express.static(clientBuildPath));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'API route not found' });
    }
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.send('Pay2Pee API (development)');
  });
}

/* ---------------- API 404 (fallback) ---------------------- */

app.use('/api/*', (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
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
