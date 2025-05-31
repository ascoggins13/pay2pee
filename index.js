// server/index.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();

// ==================== FIREBASE ADMIN INITIALIZATION ====================
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ==================== CORS CONFIGURATION ====================
const allowedOrigins = [
  'https://pay2pee.app',
  'http://localhost:3000' // For local testing
];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Preflight

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== DATABASE CONNECTION ====================
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// ==================== ROUTES ====================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/partners', require('./routes/partners'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/payments', require('./routes/payments'));

// Optional: Serve static files if needed for Firebase Hosting fallback
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (req, res) =>
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'))
  );
}

// ==================== SERVER START ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});