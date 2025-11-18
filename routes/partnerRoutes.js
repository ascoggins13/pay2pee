// routes/partnerRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');

const protect = require('../middleware/protect');
const { admin, firestore } = require('../firebase-admin'); // path from that file
const stripeService = require('../services/stripeService');

const usersCol = firestore.collection('users');
const partnersCol = firestore.collection('partners');
const locationsCol = firestore.collection('locations');

// ─────────────────────────────────────────────────────────────
// Partner router -> /api/partner/*
// ─────────────────────────────────────────────────────────────
const partnerRouter = express.Router();

/**
 * GET /api/partner/summary
 * Returns dashboard data for the currently logged-in partner.
 */
partnerRouter.get('/summary', protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Find partner (optional, if you keep a partners collection)
    const partnerDoc = await partnersCol.doc(userId).get();
    const partner = partnerDoc.exists ? partnerDoc.data() : {};

    // Find location owned by this partner
    const locSnap = await locationsCol.where('owner', '==', userId).limit(1).get();
    const hasLocation = !locSnap.empty;
    const locRef = hasLocation ? locSnap.docs[0].ref : null;
    const loc = hasLocation ? locSnap.docs[0].data() : null;

    // Compose summary (match what your UI expects)
    const data = {
      name: loc?.name || partner?.businessName || 'My Location',
      address: loc?.address || partner?.businessAddress || '—',
      isActive: Boolean(loc?.isActive),
      todayVisits: Number(loc?.todayVisits || 0),
      currentBalance: Number(partner?.pendingPayout || 0),
      lastPayoutDate: partner?.lastPayoutDate || null,
      rating: loc?.rating?.average ?? 4.8,
      reviews: Array.isArray(loc?.recentReviews) ? loc.recentReviews : [],
      trafficByDay: loc?.trafficByDay || {
        Monday: 0,
        Tuesday: 0,
        Wednesday: 0,
        Thursday: 0,
        Friday: 0,
        Saturday: 0,
        Sunday: 0,
      },
      activeGuests: Array.isArray(loc?.activeGuests) ? loc.activeGuests : [],
      locationDetails: {
        price: Number(loc?.pricing?.basePrice || 0),
        accessCode: loc?.accessCode || '—',
        hours: loc?.hours || '—',
        features: Array.isArray(loc?.amenities) ? loc.amenities : [],
        photos: Array.isArray(loc?.photos)
          ? loc.photos.map((p) => p.url || p)
          : [],
      },
      ownerName: partner?.ownerName || req.user.email?.split('@')[0] || 'Partner',
      avatarUrl: partner?.avatarUrl || '',
    };

    return res.json(data);
  } catch (err) {
    console.error('GET /partner/summary error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/partner/visibility
 * Toggle partner listing active/pause (same logic as /api/host/visibility,
 * but under /partner so the UI can call it directly).
 */
partnerRouter.put(
  '/visibility',
  protect,
  [body('isActive').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const userId = req.user.userId;
      const snap = await locationsCol.where('owner', '==', userId).limit(1).get();
      if (snap.empty) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const ref = snap.docs[0].ref;
      await ref.set({ isActive: req.body.isActive }, { merge: true });

      const updated = await ref.get();
      return res.json({ id: ref.id, ...updated.data() });
    } catch (err) {
      console.error('PUT /partner/visibility error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * POST /api/partner/onboard
 * Creates/links a Stripe Connect account for payouts (protected).
 * Optional body fields for KYC bootstrap.
 */
partnerRouter.post(
  '/onboard',
  protect,
  [
    body('email').optional().isEmail(),
    body('firstName').optional().isString(),
    body('lastName').optional().isString(),
    body('ssnLast4').optional().isString(),
    body('dobDay').optional().isInt({ min: 1, max: 31 }),
    body('dobMonth').optional().isInt({ min: 1, max: 12 }),
    body('dobYear').optional().isInt({ min: 1900 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;

      // get email from users collection if not provided
      let email = req.body.email;
      if (!email) {
        const userDoc = await usersCol.doc(userId).get();
        email = userDoc.exists ? userDoc.data().email : null;
      }
      if (!email) return res.status(400).json({ error: 'Email required' });

      const account = await stripeService.createPartnerAccount(
        userId,
        email,
        req.body
      );

      // persist on partners/{userId}
      await partnersCol.doc(userId).set(
        { stripeAccountId: account.id, onboardingStatus: 'pending_verification' },
        { merge: true }
      );

      return res.json({ success: true, stripeAccountId: account.id });
    } catch (err) {
      console.error('POST /partner/onboard error:', err);
      return res.status(500).json({ error: err.message || 'Stripe error' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Host router -> /api/host/*    (simple aliases used by your UI)
// ─────────────────────────────────────────────────────────────
const hostRouter = express.Router();

/**
 * PUT /api/host/visibility
 * Toggle partner listing active/pause.
 */
hostRouter.put(
  '/visibility',
  protect,
  [body('isActive').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const snap = await locationsCol.where('owner', '==', userId).limit(1).get();
      if (snap.empty) return res.status(404).json({ error: 'Location not found' });

      const ref = snap.docs[0].ref;
      await ref.set({ isActive: req.body.isActive }, { merge: true });

      const updated = await ref.get();
      return res.json({ id: ref.id, ...updated.data() });
    } catch (err) {
      console.error('PUT /host/visibility error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * PUT /api/host/auto-accept
 * Globally toggle autoAcceptGuests for this host's location.
 */
hostRouter.put(
  '/auto-accept',
  protect,
  [body('autoAcceptGuests').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const { autoAcceptGuests } = req.body;

      const snap = await locationsCol.where('owner', '==', userId).limit(1).get();
      if (snap.empty) return res.status(404).json({ error: 'Location not found' });

      const ref = snap.docs[0].ref;
      await ref.set({ autoAcceptGuests }, { merge: true });

      const updated = await ref.get();
      return res.json({ id: ref.id, ...updated.data() });
    } catch (err) {
      console.error('PUT /host/auto-accept error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * POST /api/host/payout
 * Trigger a manual payout of the partner's pending balance.
 */
hostRouter.post(
  '/payout',
  protect,
  [body('amountRequested').isFloat({ min: 5 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const partnerId = req.user.userId;
      const amount = Number(req.body.amountRequested);

      // Stripe transfer to connected account + Firestore updates
      const transfer = await stripeService.initiateManualPayout(partnerId, amount);

      // Respond with new balance + lastPayoutDate so UI can refresh
      const doc = await partnersCol.doc(partnerId).get();
      const pdata = doc.exists ? doc.data() : {};
      return res.json({
        success: true,
        transferId: transfer.id,
        newBalance: Number(pdata.pendingPayout || 0),
        lastPayoutDate: pdata.lastPayoutDate || new Date().toISOString(),
      });
    } catch (err) {
      console.error('POST /host/payout error:', err);
      return res.status(500).json({ error: err.message || 'Stripe error' });
    }
  }
);

module.exports = { partnerRouter, hostRouter };
