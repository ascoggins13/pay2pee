// middleware/protect.js
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = function protect(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // decoded: { userId, email, userType, iat, exp }
    req.user = { userId: decoded.userId, email: decoded.email, userType: decoded.userType };
    return next();
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
};
