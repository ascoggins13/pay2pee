// index.js — Pay2Pee Backend (Express + Firestore + Stripe)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const app = express();

/* ---------------------- CORS SETUP ------------------------ */

const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://pay2pee.app',
];

app.use(
  cors({
    origin(origin, callback) {
      // allow non-browser clients or same-origin
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // If you want to hard-block unknown origins, return an error instead:
      // return callback(new Error('Not allowed by CORS'));
      return callback(null, false);
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders:
      'Origin,X-Requested-With,Content-Type,Accept,Authorization',
  })
);

// Handle preflight for all routes
app.options('*', cors());

/* -------------------- BASIC MIDDLEWARE -------------------- */

app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1); // because Render / proxies

/* ---------------------- API ROUTES ------------------------ */

// Auth (login, register, etc)
try {
  const authRoutes = require('./routes/authRoutes');
  app.use('/api/auth', authRoutes);
} catch (err) {
  console.warn('⚠️ Could not mount /api/auth routes:', err.message);
}

// Locations (guest home screen, nearby search)
try {
  const locationRoutes = require('./routes/locationRoutes');
  app.use('/api/locations', locationRoutes);
} catch (err) {
  console.warn('⚠️ Could not mount /api/locations routes:', err.message);
}

// Payments (Stripe checkout, MyPass, subscriptions)
try {
  const paymentsRoutes = require('./routes/paymentsRoutes');
  app.use('/api/payments', paymentsRoutes);
} catch (err) {
  console.warn('⚠️ Could not mount /api/payments routes:', err.message);
}

// Partner / Host routes (partner profile, visibility, analytics, payouts)
try {
  const partnerModule = require('./routes/partnerRoutes');
  if (partnerModule.partnerRouter) {
    app.use('/api/partner', partnerModule.partnerRouter);
  } else if (typeof partnerModule === 'function') {
    // in case file exports a single router
    app.use('/api/partner', partnerModule);
  }

  if (partnerModule.hostRouter) {
    app.use('/api/host', partnerModule.hostRouter);
  }
} catch (err) {
  console.warn('⚠️ Could not mount /api/partner or /api/host routes:', err.message);
}

/* ---------------------- HEALTHCHECK ----------------------- */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  });
});

/* --------------- Serve client (production) ---------------- */

// If you’re serving the React build from the same server:
if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.join(__dirname, 'client', 'build');
  app.use(express.static(clientBuildPath));

  app.get('*', (req, res) => {
    // Let /api/* requests fall through to API handlers
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
