const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const User = require('../models/User');
const router = express.Router();

// ==================== INITIALIZATION ====================
// Secure Firebase initialization
try {
  if (!admin.apps.length) {
    const serviceAccount = require('../serviceAccountKey.json');

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
} catch (firebaseError) {
  console.error('Firebase initialization failed:', firebaseError);
  process.exit(1); // Critical failure
}
  

const firestore = admin.firestore();
const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12;

// ==================== ERROR MESSAGES ====================
const authErrors = {
  missingFields: 'All fields are required',
  invalidEmail: 'Please provide a valid email',
  passwordLength: `Password must be at least ${process.env.MIN_PASSWORD_LENGTH || 8} characters`,
  userExists: 'Email already registered',
  invalidCredentials: 'Invalid email or password',
  wrongUserType: 'Account type mismatch. Please use the correct login type.',
  registrationFailed: 'Registration failed',
  loginFailed: 'Login failed',
  serverError: 'Something went wrong. Please try again.',
  firestoreError: 'Failed to update user profile'
};

// ==================== HELPER FUNCTIONS ====================
const validateInputs = (email, password) => {
  const errors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = authErrors.invalidEmail;
  }
  if (password.length < (process.env.MIN_PASSWORD_LENGTH || 8)) {
    errors.password = authErrors.passwordLength;
  }
  return errors;
};

const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user._id,
      userType: user.userType,
      email: user.email
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// ==================== ROUTES ====================
// -------------------- Registration --------------------
router.post('/register', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { name, email, password, userType } = req.body;

    // Validation
    const missingFields = {};
    if (!name) missingFields.name = 'Name is required';
    if (!email) missingFields.email = 'Email is required';
    if (!password) missingFields.password = 'Password is required';
    if (!userType) missingFields.userType = 'Account type is required';

    if (Object.keys(missingFields).length > 0) {
      return res.status(400).json({
        success: false,
        error: authErrors.missingFields,
        missingFields
      });
    }

    const inputErrors = validateInputs(email, password);
    if (Object.keys(inputErrors).length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: inputErrors
      });
    }

    // Check existing user
    const existingUser = await User.findOne({ email }).session(session);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: authErrors.userExists
      });
    }

    // Create user
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const user = new User({
      name,
      email,
      password: hashedPassword,
      userType
    });

    await user.save({ session });

    // Firebase profile creation (with error handling)
    try {
      await firestore.collection('users').doc(user._id.toString()).set({
        name,
        email,
        userType,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActive: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
      });
    } catch (firestoreError) {
      console.error('Firestore error:', firestoreError);
      throw new Error(authErrors.firestoreError);
    }

    // Commit transaction
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

// -------------------- Login --------------------
router.post('/login', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { email, password, userType } = req.body;

    // Validation
    if (!email || !password || !userType) {
      return res.status(400).json({
        success: false,
        error: authErrors.missingFields,
        missingFields: {
          email: !email,
          password: !password,
          userType: !userType
        }
      });
    }

    // Find user
    const user = await User.findOne({ email }).session(session);
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
        error: authErrors.wrongUserType,
        correctUserType: user.userType
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

    // Update Firestore
    try {
      await firestore.collection('users').doc(user._id.toString()).update({
        lastActive: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (firestoreError) {
      console.error('Firestore update error:', firestoreError);
      // Continue without failing the request
    }

    // Generate token
    const token = generateToken(user);
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
    console.error('Login error:', error);

    res.status(500).json({
      success: false,
      error: authErrors.serverError,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    session.endSession();
  }
});

module.exports = router;