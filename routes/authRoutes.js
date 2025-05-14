const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const router = express.Router();

// Enhanced error messages
const authErrors = {
  missingFields: 'All fields are required',
  userExists: 'User already exists',
  invalidCredentials: 'Invalid email or password',
  wrongUserType: 'Account type mismatch - please use the correct login form',
  registrationFailed: 'Registration failed',
  loginFailed: 'Login failed'
};

// Helper function for consistent responses
const sendError = (res, status, message) => {
  return res.status(status).json({ success: false, message });
};

// User registration endpoint
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, userType } = req.body;
   
    // Validate input
    if (!name || !email || !password || !userType) {
      return sendError(res, 400, authErrors.missingFields);
    }
   
    // Validate userType
    if (!['user', 'partner'].includes(userType)) {
      return sendError(res, 400, 'Invalid account type specified');
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return sendError(res, 400, authErrors.userExists);
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
   
    await user.save();
   
    // Create token
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
      userType: user.userType,
      name: user.name
    });
  } catch (error) {
    console.error('Registration error:', error);
    sendError(res, 500, authErrors.registrationFailed);
  }
});

// User login endpoint
router.post('/login', async (req, res) => {
  try {
    const { email, password, userType } = req.body;
   
    // Validate input
    if (!email || !password || !userType) {
      return sendError(res, 400, authErrors.missingFields);
    }
   
    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return sendError(res, 401, authErrors.invalidCredentials);
    }
   
    // Verify user type matches
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
   
    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return sendError(res, 401, authErrors.invalidCredentials);
    }
   
    // Create token
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
      userType: user.userType,
      name: user.name
    });
  } catch (error) {
    console.error('Login error:', error);
    sendError(res, 500, authErrors.loginFailed);
  }
});

module.exports = router;

