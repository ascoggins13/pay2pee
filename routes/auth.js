// routes/auth.js (Firestore-only)
// Endpoints:
//   POST /auth/register
//   POST /auth/login
//
// Returns (success path, both routes):
//   { success: true, token, userId, userType, name }
//
// Notes:
// - No Mongo/Mongoose required.
// - Hashing happens ONLY on the server (bcrypt).
// - Uses Firebase Admin SDK Firestore as the source of truth.
// - Keeps your "wrong account type" behavior with { correctUserType } on 403.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { admin, firestore } = require('../firebase-admin'); // path from that file

const router = express.Router();

// Ensure Firebase Admin is initialized somewhere once in your app.
// If not, this will initialize with default credentials/environment.
if (!admin.apps.length) {
  admin.initializeApp();
}
const firestore = admin.firestore();
const usersCol = firestore.collection('users');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SALT_ROUNDS = 10;

// Helpers
const normalizeEmail = (e) => (e || '').trim().toLowerCase();
const now = () => admin.firestore.FieldValue.serverTimestamp();

// Issue a JWT with your standard claims
function issueJwt({ userId, email, userType }) {
  return jwt.sign({ userId, email, userType }, JWT_SECRET, { expiresIn: '7d' });
}

// Shape the success payload exactly like your frontend expects
function successAuthPayload({ id, name, userType, email }) {
  const token = issueJwt({ userId: id, email, userType });
  return { success: true, token, userId: id, userType, name };
}
// --- POST /auth/register ---
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, userType } = req.body || {};

    if (!name || !email || !password || !userType) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    const emailNorm = normalizeEmail(email);
    const typeNorm = String(userType).toLowerCase();
    if (!['user', 'partner'].includes(typeNorm)) {
      return res.status(400).json({ success: false, error: 'Invalid userType' });
    }

    // Check for existing user by email (lowercased)
    const existingSnap = await usersCol.where('emailLower', '==', emailNorm).limit(1).get();
    if (!existingSnap.empty) {
      return res.status(409).json({ success: false, error: 'Email already registered' });
    }

    // Hash password (DO NOT hash on the client)
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create Firestore doc
    const docRef = usersCol.doc(); // auto id
    await docRef.set({
      name: name.trim(),
      email: email.trim(),
      emailLower: emailNorm,
      userType: typeNorm,              // 'user' | 'partner'
      passwordHash,                    // secure hash
      status: 'active',
      createdAt: now(),
      lastActive: now(),
    });

    // Success payload
    return res.json(
      successAuthPayload({
        id: docRef.id,
        name: name.trim(),
        userType: typeNorm,
        email: emailNorm,
      })
    );
  } catch (err) {
    console.error('REGISTER error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});
// --- POST /auth/login ---
router.post('/login', async (req, res) => {
  try {
    const { email, password, userType } = req.body || {};
    if (!email || !password || !userType) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const emailNorm = normalizeEmail(email);
    const typeAttempt = String(userType).toLowerCase();

    // Lookup by emailLower
    const snap = await usersCol.where('emailLower', '==', emailNorm).limit(1).get();
    if (snap.empty) {
      // Avoid leaking existence: generic invalid creds
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const doc = snap.docs[0];
    const user = { id: doc.id, ...doc.data() };

    // Enforce correct userType (keeps your previous behavior)
    if (user.userType !== typeAttempt) {
      return res.status(403).json({
        success: false,
        error: 'Account type mismatch. Please log in with the correct account type.',
        correctUserType: user.userType, // 'user' or 'partner'
      });
    }

    // Compare password
    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    // Update lastActive (fire-and-forget)
    doc.ref.update({ lastActive: now() }).catch((e) => {
      console.warn('lastActive update failed:', e?.message || e);
    });
    // Success payload
    return res.json(
      successAuthPayload({
        id: user.id,
        name: user.name || '',
        userType: user.userType,
        email: emailNorm,
      })
    );
  } catch (err) {
    console.error('LOGIN error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;