require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path'); // Add this for static files

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(helmet());
app.use(express.urlencoded({ extended: true }));

// Database
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// API Routes (MUST come before static files)
app.use('/api/locations', require('./routes/locations'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/payments', require('./routes/paymentsRoutes'));
app.use('/stripe-webhooks', require('./routes/stripeWebhooksRoutes'));

// ===== Add This Section =====
// Serve static files from React (if in production)
if (process.env.NODE_ENV === 'production') {
  // 1. Set static folder
  app.use(express.static(path.join(__dirname, 'client/build')));

  // 2. Handle React routing (return all requests to React app)
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}
// ===========================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));