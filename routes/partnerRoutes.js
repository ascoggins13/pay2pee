// routes/partnerRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');

const protect = require('../middleware/protect');
const { admin, firestore } = require('../firebase-admin');
const stripeService = require('../services/stripeService');

const usersCol = firestore.collection('users');
const partnersCol = firestore.collection('partners');
const locationsCol = firestore.collection('locations');

const FieldValue = admin.firestore.FieldValue;

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

    const [userDoc, partnerDoc, locSnap] = await Promise.all([
      usersCol.doc(userId).get(),
      partnersCol.doc(userId).get(),
      locationsCol.where('owner', '==', userId).limit(1).get(),
    ]);

    const user = userDoc.exists ? userDoc.data() : {};
    const partner = partnerDoc.exists ? partnerDoc.data() : {};
    const hasLocation = !locSnap.empty;
    const locRef = hasLocation ? locSnap.docs[0].ref : null;
    const loc = hasLocation ? locSnap.docs[0].data() : {};

    const stripeStatus = partner.stripeStatus || {};

    const data = {
      // high-level identity
      partnerId: userId,
      email: user.email || partner.email || null,

      // header
      name: loc.name || partner.businessName || 'Your Bathroom Name',
      address:
        loc.address || partner.businessAddress || 'Add your address so guests can find you.',
      isActive: loc.isActive !== false,

      // stats
      todayVisits: Number(loc.todayVisits || 0),
      currentBalance: Number(partner.pendingPayout || 0),
      lastPayoutDate: partner.lastPayoutDate || null,
      rating: loc.rating || 4.8,

      // reviews
      reviews: Array.isArray(loc.recentReviews) ? loc.recentReviews : [],

      // queue / guests (optional)
      activeGuests: Array.isArray(loc.activeGuests) ? loc.activeGuests : [],

      // listing details (this is what PartnerHomeScreen expects)
      locationDetails: {
        price: Number(loc.price || loc.pricing?.basePrice || 0),
        accessCode: loc.accessCode || '',
        hours: loc.hours || '—',
        description: loc.description || '',
        features: Array.isArray(loc.amenities) ? loc.amenities : [],
        photos: Array.isArray(loc.photos) ? loc.photos : [],
      },

      // owner identity
      ownerName: partner.ownerName || user.name || user.email?.split('@')[0] || 'Partner',
      avatarUrl: partner.avatarUrl || user.avatarUrl || '',

      // Stripe
      stripeAccountId: partner.stripeAccountId || null,
      stripeStatus: {
        charges_enabled: !!stripeStatus.charges_enabled,
        payouts_enabled: !!stripeStatus.payouts_enabled,
        details_submitted: !!stripeStatus.details_submitted,
      },
    };

    return res.json(data);
  } catch (err) {
    console.error('GET /partner/summary error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/partner/location
 * Create or update the partner's primary location (bathroom listing).
 * This is called from PartnerHomeScreen.handleSaveDetails().
 */
partnerRouter.put(
  '/location',
  protect,
  [
    body('name').optional().isString(),
    body('address').optional().isString(),
    body('accessCode').optional().isString(),
    body('price').optional().isFloat({ min: 0 }),
    body('description').optional().isString(),
    body('features').optional().isArray(),
    body('photos').optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const userId = req.user.userId;
      const {
        name,
        address,
        accessCode,
        price = 0,
        description = '',
        features = [],
        photos = [],
      } = req.body;

      // Find existing location or create a new one
      const snap = await locationsCol.where('owner', '==', userId).limit(1).get();

      let locRef;
      let existing = {};
      if (snap.empty) {
        locRef = locationsCol.doc();
        existing = {};
      } else {
        locRef = snap.docs[0].ref;
        existing = snap.docs[0].data() || {};
      }

      const update = {
        owner: userId,
        name: name !== undefined ? name : existing.name,
        address: address !== undefined ? address : existing.address,
        accessCode:
          accessCode !== undefined ? accessCode : existing.accessCode || '',
        price: Number(price),
        description,
        amenities: Array.isArray(features) ? features : [],
        photos: Array.isArray(photos) ? photos : [],
        isActive: existing.isActive !== undefined ? existing.isActive : true,
        updatedAt: FieldValue.serverTimestamp(),
      };

      await locRef.set(update, { merge: true });
      const updatedSnap = await locRef.get();
      const loc = updatedSnap.data() || {};

      // Shape response like PartnerHomeScreen expects
      return res.json({
        name: loc.name || '',
        address: loc.address || '',
        isActive: loc.isActive !== false,
        locationDetails: {
          price: Number(loc.price || 0),
          accessCode: loc.accessCode || '',
          description: loc.description || '',
          hours: loc.hours || '—',
          features: Array.isArray(loc.amenities) ? loc.amenities : [],
          photos: Array.isArray(loc.photos) ? loc.photos : [],
        },
      });
    } catch (err) {
      console.error('PUT /partner/location error:', err);
      return res.status(500).json({
        error: err.message || 'Could not save bathroom details. Please try again.',
      });
    }
  }
);

/**
 * PUT /api/partner/visibility
 * Toggle partner listing active/pause (used by the Status toggle).
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
      const { isActive } = req.body;

      const snap = await locationsCol.where('owner', '==', userId).limit(1).get();
      if (snap.empty) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const ref = snap.docs[0].ref;
      await ref.set({ isActive }, { merge: true });

      const updated = await ref.get();
      const loc = updated.data() || {};
      return res.json({
        id: ref.id,
        name: loc.name || '',
        isActive: loc.isActive !== false,
      });
    } catch (err) {
      console.error('PUT /partner/visibility error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * POST /api/partner/onboard
 * (Optional) create/link a Stripe account using your stripeService helper.
 * Note: your PartnerHomeScreen currently uses /api/connect/onboard-link instead,
 * but this stays for compatibility.
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
// Host router -> /api/host/*   (aliases used by other parts of app)
// ─────────────────────────────────────────────────────────────
const hostRouter = express.Router();

/**
 * PUT /api/host/visibility
 * Legacy alias: same logic as /api/partner/visibility
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
      const { isActive } = req.body;

      const snap = await locationsCol.where('owner', '==', userId).limit(1).get();
      if (snap.empty) return res.status(404).json({ error: 'Location not found' });

      const ref = snap.docs[0].ref;
      await ref.set({ isActive }, { merge: true });

      const updated = await ref.get();
      const loc = updated.data() || {};
      return res.json({
        id: ref.id,
        name: loc.name || '',
        isActive: loc.isActive !== false,
      });
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
      const loc = updated.data() || {};
      return res.json({
        id: ref.id,
        autoAcceptGuests: !!loc.autoAcceptGuests,
      });
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

      const transfer = await stripeService.initiateManualPayout(partnerId, amount);

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
