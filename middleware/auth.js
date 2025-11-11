// middleware/auth.js
const jwt = require('jsonwebtoken');
const { firestore } = require('../firebase-admin');

async function protect(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, error: 'No auth token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // e.g. { userId, email, userType }

    if (decoded.userId) {
      const snap = await firestore.collection('users').doc(decoded.userId).get();
      if (snap.exists) req.userDoc = { id: snap.id, ...snap.data() };
    }
    next();
  } catch (err) {
    console.error('Auth protect error:', err.message);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

async function optionalAuth(req, _res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      if (decoded.userId) {
        const snap = await firestore.collection('users').doc(decoded.userId).get();
        if (snap.exists) req.userDoc = { id: snap.id, ...snap.data() };
      }
    }
  } catch (err) {
    console.warn('optionalAuth warn:', err.message);
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.user?.userType || req.userDoc?.userType || req.user?.role || req.userDoc?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ success: false, error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

module.exports = { protect, optionalAuth, requireRole };
