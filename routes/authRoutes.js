const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const User = require('../models/User');
const router = express.Router();

// Initialize Firebase if not already done
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require('../path/to/firebase-admin-sdk.json')),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}
const firestore = admin.firestore();

// Error messages
const authErrors = {
  missingFields: 'All fields are required',
  invalidEmail: 'Please provide a valid email',
  passwordLength: 'Password must be at least 8 characters',
  userExists: 'Email already registered',
  invalidCredentials: 'Invalid email or password',
  wrongUserType: 'Account type mismatch. Please use the correct login type.',
  registrationFailed: 'Registration failed',
  loginFailed: 'Login failed',
  serverError: 'Something went wrong. Please try again.'
};

// Helper function to validate email format
const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

// Helper function to validate password length
const isValidPassword = (password) => {
  return password.length >= 8;
};

// Helper function to generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user._id,
      userType: user.userType,
      email: user.email
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// Register a new user
router.post('/register', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { name, email, password, userType } = req.body;

    // Validate required fields
    if (!name || !email || !password || !userType) {
      return res.status(400).json({ 
        success: false,
        error: authErrors.missingFields,
        missingFields: {
          name: !name,
          email: !email,
          password: !password,
          userType: !userType
        }
      });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        error: authErrors.invalidEmail
      });
    }

    // Validate password length
    if (!isValidPassword(password)) {
      return res.status(400).json({
        success: false,
        error: authErrors.passwordLength
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email }).session(session);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: authErrors.userExists
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user in MongoDB
    const user = new User({
      name,
      email,
      password: hashedPassword,
      userType
    });
    await user.save({ session });

    // Create Firestore profile
    await firestore.collection('users').doc(user._id.toString()).set({
      name,
      email,
      userType,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastActive: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active'
    });

    // Generate JWT token
    const token = generateToken(user);

    await session.commitTransaction();

    res.status(201).json({
      success: true,
      token,
      userId: user._id,
      userType: user.userType,
      name: user.name
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Registration error:', error);
    
    let errorMessage = authErrors.registrationFailed;
    if (error.name === 'ValidationError') {
      errorMessage = Object.values(error.errors).map(e => e.message).join(', ');
    } else if (error.code === 11000) {
      errorMessage = authErrors.userExists;
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    session.endSession();
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { email, password, userType } = req.body;

    // Validate required fields
    if (!email || !password || !userType) {
      return res.status(400).json({
        success: false,
        error: authErrors.missingFields
      });
    }

    // Find user in MongoDB
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: authErrors.invalidCredentials
      });
    }

    // Verify user type matches
    if (user.userType !== userType) {
      return res.status(403).json({
        success: false,
        error: authErrors.wrongUserType,
        correctUserType: user.userType // Tell frontend the correct type
      });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: authErrors.invalidCredentials
      });
    }

    // Update last active in Firestore
    await firestore.collection('users').doc(user._id.toString()).update({
      lastActive: admin.firestore.FieldValue.serverTimestamp()
    });

    // Generate JWT token
    const token = generateToken(user);

    res.json({
      success: true,
      token,
      userId: user._id,
      userType: user.userType,
      name: user.name
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: authErrors.serverError,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;