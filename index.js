require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');
const morgan = require('morgan');

// Initialize Express app
const app = express();

// ==================== ENHANCED ERROR HANDLING ====================
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// ==================== FIREBASE ADMIN INITIALIZATION ====================
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  console.log('✅ Firebase Admin initialized');
} catch (firebaseError) {
  console.error('❌ Firebase initialization failed:', firebaseError);
}
console.log('Module paths:', require('module')._paths);
console.log('Trying to require router...');
try {
  const router = require('./node_modules/express/lib/router');
  console.log('Successfully required router!');
} catch (err) {
  console.error('Require error:', err);
}

// ==================== MIDDLEWARE ====================
// Enhanced CORS configuration
app.use(cors({
  origin: [
    'https://pay2pee.app',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Trust proxy
app.set('trust proxy', 1);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use(morgan('dev'));

// ==================== DATABASE CONNECTION ====================
const connectWithRetry = () => {
  mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    retryWrites: true,
    w: 'majority'
  })
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    setTimeout(connectWithRetry, 5000);
  });
};

connectWithRetry();

// ==================== ROUTES ====================
// Health Check
app.get('/api/healthcheck', (req, res) => {
  res.json({ 
    status: 'healthy',
    serverTime: new Date().toISOString(),
    dbStatus: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    firebaseStatus: admin.apps.length > 0 ? 'connected' : 'disconnected'
  });
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/partners', require('./routes/partnerRoutes'));
app.use('/api/locations', require('./routes/locationRoutes'));
app.use('/api/bathrooms', require('./routes/bathroomImageRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/payments', require('./routes/paymentsRoutes'));

// ==================== PRODUCTION CONFIG ====================
if (process.env.NODE_ENV === 'production') {
  // Serve static files
  app.use(express.static(path.join(__dirname, 'client/build')));

  // Handle React routing
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

// ==================== ERROR HANDLING ====================
// 404 Handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('⚠️ Server Error:', err.stack);
  res.status(500).json({ 
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Server error'
  });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated');
  });
});