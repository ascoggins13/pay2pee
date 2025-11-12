// routes/auth.js — Firestore auth (shared admin instance)
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { admin, firestore } = require('../firebase-admin'); // <-- use shared instance

const router = express.Router();

const usersCol = firestore.collection('users');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SALT_ROUNDS = 10;

const normalizeEmail = (e) => (e || '').trim().toLowerCase();
const now = () => admin.firestore.FieldValue.serverTimestamp();

function issueJwt({ userId, email, userType }) {
  return jwt.sign({ userId, email, userType }, JWT_SECRET, { expiresIn: '7d' });
}
function successAuthPayload({ id, name, userType, email }) {
  const token = issueJwt({ userId: id, email, userType });
  return { success: true, token, userId: id, userType, name };
}

// POST /api/auth/register
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

    const existingSnap = await usersCol.where('emailLower', '==', emailNorm).limit(1).get();
    if (!existingSnap.empty) {
      return res.status(409).json({ success: false, error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const docRef = usersCol.doc();
    await docRef.set({
      name: name.trim(),
      email: email.trim(),
      emailLower: emailNorm,
      userType: typeNorm,
      passwordHash,
      status: 'active',
      createdAt: now(),
      lastActive: now(),
    });

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

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, userType } = req.body || {};
    if (!email || !password || !userType) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    const emailNorm = normalizeEmail(email);
    const typeAttempt = String(userType).toLowerCase();

    const snap = await usersCol.where('emailLower', '==', emailNorm).limit(1).get();
    if (snap.empty) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const doc = snap.docs[0];
    const user = { id: doc.id, ...doc.data() };

    if (user.userType !== typeAttempt) {
      return res.status(403).json({
        success: false,
        error: 'Account type mismatch. Please log in with the correct account type.',
        correctUserType: user.userType,
      });
    }

    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    doc.ref.update({ lastActive: now() }).catch(() => {});
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
