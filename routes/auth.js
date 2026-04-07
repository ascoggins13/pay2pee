// routes/auth.js — Firestore auth (shared admin instance)
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { admin, firestore } = require('../firebase-admin');

const router = express.Router();

const usersCol = firestore.collection('users');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SALT_ROUNDS = 10;

const normalizeEmail = (e) => (e || '').trim().toLowerCase();
const now = () => admin.firestore.FieldValue.serverTimestamp();

console.log("LEADS firebase-admin resolved to:", require.resolve("../firebase-admin.js"));
const fb = require("../firebase-admin.js");
console.log("LEADS firebase keys:", Object.keys(fb));
console.log("LEADS has firestore?", !!fb.firestore, "type:", typeof fb.firestore);

function issueJwt({ userId, email, userType }) {
  return jwt.sign({ userId, email, userType }, JWT_SECRET, { expiresIn: '7d' });
}

function successAuthPayload({ id, name, userType, email }) {
  const token = issueJwt({ userId: id, email, userType });
  return { success: true, token, userId: id, userType, name };
}

// ========================
// POST /api/auth/register
// ========================
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

    const existingSnap = await usersCol
      .where('emailLower', '==', emailNorm)
      .limit(1)
      .get();

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

// =====================
// POST /api/auth/login
// =====================
router.post('/login', async (req, res) => {
  try {
    const { email, password, userType } = req.body || {};
    if (!email || !password || !userType) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const emailNorm = normalizeEmail(email);
    const typeAttempt = String(userType || '').toLowerCase();

    const snap = await usersCol
      .where('emailLower', '==', emailNorm)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const doc = snap.docs[0];
    const user = { id: doc.id, ...doc.data() };
    const storedType = String(user.userType || '').toLowerCase();

    // Partners MUST log in as partner
    if (storedType === 'partner' && typeAttempt !== 'partner') {
      return res.status(403).json({
        success: false,
        error: 'This is a partner account. Please log in using the Partner option.',
        correctUserType: 'partner',
      });
    }

    // Users CANNOT log in as partner
    if (typeAttempt === 'partner' && storedType !== 'partner') {
      return res.status(403).json({
        success: false,
        error: 'This is not a partner account. Please log in as a guest.',
        correctUserType: storedType,
      });
    }

    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) {
      return res
        .status(401)
        .json({ success: false, error: 'Invalid email or password' });
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

// =====================================
// POST /api/auth/forgot-password
// =====================================
router.post('/forgot-password', async (req, res) => {
  try {
    const emailNorm = normalizeEmail(req.body?.email);

    if (!emailNorm) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    const snap = await usersCol
      .where('emailLower', '==', emailNorm)
      .limit(1)
      .get();

    // Always return success-like response so people can't probe accounts
    if (snap.empty) {
      return res.json({
        success: true,
        message: 'If that email exists, a reset link has been sent.',
      });
    }

    const doc = snap.docs[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiresAt = admin.firestore.Timestamp.fromMillis(
      Date.now() + 1000 * 60 * 30 // 30 minutes
    );

    await doc.ref.set(
      {
        passwordResetToken: resetToken,
        passwordResetTokenExpiresAt: resetTokenExpiresAt,
        updatedAt: now(),
      },
      { merge: true }
    );

    // TODO:
    // Send email here when your email service is ready.
    // Example reset URL:
    // `${process.env.CLIENT_URL}/#/reset-password?token=${resetToken}&email=${encodeURIComponent(emailNorm)}`

    console.log('[FORGOT PASSWORD] Reset token created for:', emailNorm);
    console.log('[FORGOT PASSWORD] Token:', resetToken);

    return res.json({
      success: true,
      message: 'If that email exists, a reset link has been sent.',
    });
  } catch (err) {
    console.error('FORGOT PASSWORD error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

module.exports = router;