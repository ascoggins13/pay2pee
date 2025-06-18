const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth: firebaseAuth } = require('firebase-admin');

// Verify JWT token and protect routes
const protect = async (req, res, next) => {
  let token;
  
  // Get token from header
  if (req.headers.authorization?.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  
  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database
    req.user = await User.findById(decoded.id).select('-password');
    
    if (!req.user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    next();
  } catch (err) {
    console.error('Token verification error:', err);
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Role-based authorization
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }
    
    if (!roles.includes(req.user.userType)) {
      return res.status(403).json({ 
        message: `Access denied. Required roles: ${roles.join(', ')}`
      });
    }
    
    next();
  };
};

// Firebase authentication middleware
const firebaseProtect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decodedToken = await firebaseAuth().verifyIdToken(token);
    req.firebaseUser = decodedToken;
    next();
  } catch (err) {
    console.error('Firebase auth error:', err);
    res.status(401).json({ message: 'Invalid Firebase token' });
  }
};

module.exports = {
  protect,
  restrictTo,
  firebaseProtect
};