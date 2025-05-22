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
  wrongUserType: 'Account type mismatch',
  registrationFailed: 'Registration failed',
  loginFailed: 'Login failed'
};

router.post('/register', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { name, email, password, userType } = req.body;

    // Validation
    if (!name || !email || !password || !userType) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        error: authErrors.missingFields,
        missing: {
          name: !name,
          email: !email,
          password: !password,
          userType: !userType
        }
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: authErrors.invalidEmail
      });
    }

    if (password.length < 8) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: authErrors.passwordLength
      });
    }

    // Check existing user
    const existingUser = await User.findOne({ email }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        error: authErrors.userExists
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
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

    // Generate token
    const token = jwt.sign(
      {
        userId: user._id,
        userType: user.userType,
        email: user.email
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    await session.commitTransaction();

    res.json({
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

router.post('/login', async (req, res) => {
  try {
    const { email, password, userType } = req.body;

    // Validation
    if (!email || !password || !userType) {
      return res.status(400).json({
        success: false,
        error: authErrors.missingFields
      });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: authErrors.invalidCredentials
      });
    }

    // Verify user type
    if (user.userType !== userType) {
      return res.status(403).json({
        success: false,
        error: `${authErrors.wrongUserType}. Please login as a ${user.userType}`
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

    // Update last active
    await firestore.collection('users').doc(user._id.toString()).update({
      lastActive: admin.firestore.FieldValue.serverTimestamp()
    });

    // Generate token
    const token = jwt.sign(
      {
        userId: user._id,
        userType: user.userType,
        email: user.email
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

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
      error: authErrors.loginFailed,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;