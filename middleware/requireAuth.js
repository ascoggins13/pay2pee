// middleware/requireAuth.js
const { admin, firestore } = require('../firebase-admin');

module.exports = async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({ error: 'No auth token provided' });
    }

    // Verify Firebase ID token
    const decoded = await admin.auth().verifyIdToken(token);

    // Basic user object on the request
    req.user = {
      uid: decoded.uid,
    };

    // Optional: hydrate from Firestore `users` collection
    const userDoc = await firestore.collection('users').doc(decoded.uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();

      req.user.userType = data.userType || null;

      // For partners, use partnerId if you store one, otherwise fall back to uid
      if (data.userType === 'partner') {
        req.user.partnerId = data.partnerId || decoded.uid;
      }
    }

    return next();
  } catch (err) {
    console.error('Auth error in requireAuth:', err);
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }
};
