const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const User = require('../models/User');
const router = express.Router();

// Initialize Firebase Admin if not already done
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require('../path/to/firebase-admin-sdk.json')),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const firestore = admin.firestore();

const authErrors = {
  missingFields: 'All fields are required',
  userExists: 'User already exists',
  invalidCredentials: 'Invalid email or password',
  wrongUserType: 'Account type mismatch - please use the correct login form',
  profileCreationFailed: 'Profile creation failed',
  registrationFailed: 'Registration failed',
  loginFailed: 'Login failed'
};

const sendError = (res, status, message) => {
  return res.status(status).json({ success: false, message });
};

router.post('/register', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { name, email, password, userType } = req.body;

    // Validation
    if (!name || !email || !password || !userType) {
      await session.abortTransaction();
      return sendError(res, 400, authErrors.missingFields);
    }

    if (!['user', 'partner'].includes(userType)) {
      await session.abortTransaction();
      return sendError(res, 400, 'Invalid account type specified');
    }

    // Check existing user
    const existingUser = await User.findOne({ email }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      return sendError(res, 400, authErrors.userExists);
    }

    // Create auth record
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({
      name,
      email,
      password: hashedPassword,
      userType
    });

    await user.save({ session });

    // Create Firestore profile
    try {
      await firestore.collection('users').doc(user._id.toString()).set({
        name,
        email,
        userType,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActive: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
      }, { merge: true });
    } catch (firestoreError) {
      await session.abortTransaction();
      console.error('Firestore profile creation failed:', firestoreError);
      return sendError(res, 500, authErrors.profileCreationFailed);
    }

    // Generate JWT
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
    sendError(res, 500, authErrors.registrationFailed);
  } finally {
    session.endSession();
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password, userType } = req.body;

    if (!email || !password || !userType) {
      return sendError(res, 400, authErrors.missingFields);
    }

    const user = await User.findOne({ email });
    if (!user) {
      return sendError(res, 401, authErrors.invalidCredentials);
    }

    // Verify user type
    if (user.userType !== userType) {
      const userTypes = {
        user: 'bathroom finder',
        partner: 'bathroom host'
      };
      return sendError(res, 403,
        `This account is for ${userTypes[user.userType]}. ` +
        `Please use the ${userTypes[user.userType]} login.`
      );
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return sendError(res, 401, authErrors.invalidCredentials);
    }

    // Update last login in Firestore
    try {
      await firestore.collection('users').doc(user._id.toString()).update({
        lastActive: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (firestoreError) {
      console.error('Firestore update failed:', firestoreError);
    }

    // Generate JWT
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
    sendError(res, 500, authErrors.loginFailed);
  }
});

// Add this new endpoint for profile fetching
router.get('/profile/:userId', async (req, res) => {
  try {
    const doc = await firestore.collection('users').doc(req.params.userId).get();
    if (!doc.exists) {
      return sendError(res, 404, 'Profile not found');
    }
    res.json({ success: true, profile: doc.data() });
  } catch (error) {
    console.error('Profile fetch error:', error);
    sendError(res, 500, 'Failed to fetch profile');
  }
});

module.exports = router;
