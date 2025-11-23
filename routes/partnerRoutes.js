// routes/partnerRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const axios = require('axios');

const protect = require('../middleware/protect');
const { admin, firestore } = require('../firebase-admin');
const stripeService = require('../services/stripeService');
// 🔹 NEW: direct Stripe import so we can read connected account balances
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const usersCol = firestore.collection('users');
const partnersCol = firestore.collection('partners');
const locationsCol = firestore.collection('locations');
const guestVisitsCol = firestore.collection('guestVisits');
const FieldValue = admin.firestore.FieldValue;

// Helper: geocode an address -> { lat, lng } or null
async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !address) return null;

  try {
    const res = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      {
        params: { address, key: apiKey },
      }
    );

    if (
      !res.data ||
      res.data.status !== 'OK' ||
      !Array.isArray(res.data.results) ||
      res.data.results.length === 0
    ) {
      console.warn(
        'Geocoding failed:',
        res.data?.status,
        res.data?.error_message
      );
      return null;
    }

    const loc = res.data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    console.error('Geocoding error:', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Partner router -> /api/partner/*
// ─────────────────────────────────────────────────────────────
const partnerRouter = express.Router();

/**
 * GET /api/partner/summary
 * Used by PartnerHomeScreen to load profile + location summary info.
 * - Refreshes Stripe status from Stripe when possible
 * - Computes today's guests from guestVisits
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
    const locDoc = hasLocation ? locSnap.docs[0] : null;
    const loc = hasLocation ? locDoc.data() : {};
    const locId = hasLocation ? locDoc.id : null;

    // 🔹 Refresh Stripe status live if we have a Stripe account ID
    let stripeStatus = partner.stripeStatus || {};
    if (partner.stripeAccountId && typeof stripeService.getAccount === 'function') {
      try {
        const acct = await stripeService.getAccount(partner.stripeAccountId);
        stripeStatus = {
          charges_enabled: !!acct.charges_enabled,
          payouts_enabled: !!acct.payouts_enabled,
          details_submitted: !!acct.details_submitted,
        };

        // Persist latest status in Firestore
        await partnersCol.doc(userId).set(
          {
            stripeStatus,
            onboardingStatus: acct.details_submitted
              ? 'verified'
              : 'pending_verification',
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      } catch (err) {
        console.error('Error refreshing Stripe account status:', err);
        // fall back to whatever was stored
        stripeStatus = partner.stripeStatus || {};
      }
    }

    // 🔹 NEW: read Stripe balance for this partner's connected account
    let stripeBalance = null;
    if (partner.stripeAccountId && process.env.STRIPE_SECRET_KEY) {
      try {
        const bal = await stripe.balance.retrieve({
          stripeAccount: partner.stripeAccountId,
        });

        const available = Array.isArray(bal.available) ? bal.available : [];
        const usdAvail =
          available.find((b) => b.currency === 'usd') || available[0];

        const amountCents = usdAvail ? usdAvail.amount : 0;
        stripeBalance = amountCents / 100; // convert to dollars
      } catch (err) {
        console.error('Error retrieving Stripe balance for partner:', err);
      }
    }

    // 🔹 Compute today's guests from guestVisits (for PartnerHomeScreen)
    let todayCount = 0;
    if (locId) {
      try {
        const visitsSnap = await guestVisitsCol
          .where('locationId', '==', locId)
          .get();

        const dayNames = [
          'Sunday',
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
          'Saturday',
        ];
        const now = new Date();
        const todayName = dayNames[now.getDay()];

        const visits = visitsSnap.docs.map((d) => d.data());

        todayCount = visits.filter((v) => {
          let visitDay = v.dayOfWeek;
          if (!visitDay) {
            const ts = v.createdAt || v.startTime;
            if (ts && typeof ts.toDate === 'function') {
              visitDay = dayNames[ts.toDate().getDay()];
            }
          }
          return visitDay === todayName;
        }).length;
      } catch (err) {
        console.error('Error computing todayVisits in /partner/summary:', err);
        todayCount = 0;
      }
    }

    const computedCurrentBalance =
      stripeBalance != null
        ? Number(stripeBalance.toFixed(2))
        : Number(partner.pendingPayout || 0);

    const data = {
      partnerId: userId,
      email: user.email || partner.email || null,

      name: loc.name || partner.businessName || 'Your Bathroom Name',
      address:
        loc.address ||
        partner.businessAddress ||
        'Add your address so guests can find you.',
      isActive: loc.isActive !== false,

      // 🔹 Use computed value instead of loc.todayVisits
      todayVisits: todayCount,

      // 🔹 NOW driven by Stripe balance when available
      currentBalance: computedCurrentBalance,
      // Optional extra field if you want to inspect it directly
      stripeBalance:
        stripeBalance != null ? Number(stripeBalance.toFixed(2)) : null,

      lastPayoutDate: partner.lastPayoutDate || null,
      rating: loc.rating || 4.8,

      reviews: Array.isArray(loc.recentReviews) ? loc.recentReviews : [],
      activeGuests: Array.isArray(loc.activeGuests) ? loc.activeGuests : [],

      locationDetails: {
        price: Number(loc.price || loc.pricing?.basePrice || 0),
        accessCode: loc.accessCode || '',
        hours: loc.hours || '—',
        description: loc.description || '',
        features: Array.isArray(loc.amenities) ? loc.amenities : [],
        photos: Array.isArray(loc.photos) ? loc.photos : [],
      },

      ownerName:
        partner.ownerName ||
        user.name ||
        (user.email ? user.email.split('@')[0] : 'Partner'),
      avatarUrl: partner.avatarUrl || user.avatarUrl || '',

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
 * Creates/updates the primary bathroom location for this partner.
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
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

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

      const snap = await locationsCol
        .where('owner', '==', userId)
        .limit(1)
        .get();

      let locRef;
      let existing = {};
      if (snap.empty) {
        locRef = locationsCol.doc();
      } else {
        locRef = snap.docs[0].ref;
        existing = snap.docs[0].data() || {};
      }

      const addressChanged =
        typeof address === 'string' &&
        address.trim() &&
        address.trim() !== (existing.address || '').trim();

      let coordinates = existing.coordinates || null;

      if (addressChanged || !coordinates) {
        const geo = await geocodeAddress(address || existing.address);
        if (geo) {
          coordinates = geo;
        }
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
        coordinates: coordinates || existing.coordinates || null,
        isActive: existing.isActive !== undefined ? existing.isActive : true,
        updatedAt: FieldValue.serverTimestamp(),
      };

      await locRef.set(update, { merge: true });
      const updatedSnap = await locRef.get();
      const loc = updatedSnap.data() || {};

      return res.json({
        name: loc.name || '',
        address: loc.address || '',
        isActive: loc.isActive !== false,
        coordinates: loc.coordinates || null,
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
        error:
          err.message ||
          'Could not save bathroom details. Please try again.',
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Host router -> /api/host/*
// ─────────────────────────────────────────────────────────────
const hostRouter = express.Router();

/**
 * PUT /api/host/visibility
 * Toggles whether this host's location is active/visible to guests.
 */
hostRouter.put(
  '/visibility',
  protect,
  [body('isActive').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const { isActive } = req.body;

      const snap = await locationsCol
        .where('owner', '==', userId)
        .limit(1)
        .get();

      if (snap.empty)
        return res.status(404).json({ error: 'Location not found' });

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
 * Toggle autoAcceptGuests for this host's location.
 */
hostRouter.put(
  '/auto-accept',
  protect,
  [body('autoAcceptGuests').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const { autoAcceptGuests } = req.body;

      const snap = await locationsCol
        .where('owner', '==', userId)
        .limit(1)
        .get();
      if (snap.empty)
        return res.status(404).json({ error: 'Location not found' });

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
 * Manual payout request for partner.
 */
hostRouter.post(
  '/payout',
  protect,
  [body('amountRequested').isFloat({ min: 5 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const partnerId = req.user.userId;
      const amount = Number(req.body.amountRequested);

      const transfer = await stripeService.initiateManualPayout(
        partnerId,
        amount
      );

      // Reload partner doc (for lastPayoutDate, etc.)
      const doc = await partnersCol.doc(partnerId).get();
      const pdata = doc.exists ? doc.data() : {};

      // 🔹 NEW: read Stripe balance again after payout so UI gets fresh number
      let stripeBalance = null;
      if (pdata.stripeAccountId && process.env.STRIPE_SECRET_KEY) {
        try {
          const bal = await stripe.balance.retrieve({
            stripeAccount: pdata.stripeAccountId,
          });
          const available = Array.isArray(bal.available) ? bal.available : [];
          const usdAvail =
            available.find((b) => b.currency === 'usd') || available[0];
          const amountCents = usdAvail ? usdAvail.amount : 0;
          stripeBalance = amountCents / 100;
        } catch (err) {
          console.error('Error retrieving Stripe balance after payout:', err);
        }
      }

      return res.json({
        success: true,
        transferId: transfer.id,
        newBalance:
          stripeBalance != null
            ? Number(stripeBalance.toFixed(2))
            : Number(pdata.pendingPayout || 0),
        lastPayoutDate: pdata.lastPayoutDate || new Date().toISOString(),
      });
    } catch (err) {
      console.error('POST /host/payout error:', err);
      return res.status(500).json({ error: err.message || 'Stripe error' });
    }
  }
);

module.exports = { partnerRouter, hostRouter };
