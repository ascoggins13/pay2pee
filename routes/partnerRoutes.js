// routes/partnerRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const axios = require('axios');

const protect = require('../middleware/protect');
const { admin, firestore } = require('../firebase-admin');
const stripeService = require('../services/stripeService');
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
 *
 * Returns the partner's dashboard summary used by PartnerHomeScreen:
 * - partnerId, email, name
 * - address, isActive
 * - todayVisits, currentBalance, lastPayoutDate
 * - rating, reviews
 * - locationDetails (price, accessCode, hours, description, features, photos)
 * - ownerName, avatarUrl
 * - stripeAccountId, stripeStatus
 */
partnerRouter.get('/summary', protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

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
    if (
      partner.stripeAccountId &&
      stripeService &&
      typeof stripeService.getAccount === 'function'
    ) {
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

    // 🔹 Fetch Stripe balance (available vs pending) for this partner
    let stripeBalanceTotal = null;
    let stripeAvailable = null;
    let stripePending = null;

    if (partner.stripeAccountId && process.env.STRIPE_SECRET_KEY) {
      try {
        const bal = await stripe.balance.retrieve({
          stripeAccount: partner.stripeAccountId,
        });

        const avail = Array.isArray(bal.available) ? bal.available[0] : null;
        const pend = Array.isArray(bal.pending) ? bal.pending[0] : null;

        stripeAvailable = avail ? avail.amount / 100 : 0; // dollars
        stripePending = pend ? pend.amount / 100 : 0; // dollars
        stripeBalanceTotal = (stripeAvailable || 0) + (stripePending || 0);
      } catch (err) {
        console.error(
          'Error fetching Stripe balance in /partner/summary:',
          err
        );
      }
    }

    // Fallback to old behavior if Stripe balance not available
    const totalBalance =
      stripeBalanceTotal !== null
        ? stripeBalanceTotal
        : Number(partner.pendingPayout || 0);

    const availableBalance =
      stripeAvailable !== null ? stripeAvailable : totalBalance;

    const pendingBalance =
      stripePending !== null ? stripePending : null;

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

    const data = {
      partnerId: userId,
      email: user.email || partner.email || null,

      name: loc.name || partner.businessName || 'Your Bathroom Name',
      address:
        loc.address ||
        partner.businessAddress ||
        'Add your address so guests can find you.',
      isActive: loc.isActive !== false,

      // 🔹 Use computed todayVisits + Stripe balances
      todayVisits: todayCount,

      // balances (Stripe-backed where available)
      currentBalance: totalBalance,
      availableBalance,
      pendingBalance,
      stripeBalance: totalBalance,
      stripeAvailableBalance: availableBalance,
      stripePendingBalance: pendingBalance,

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
 * GET /api/partner/analytics
 *
 * Returns analytics in the exact shape expected by PartnerAnalytics.js:
 * - stats: { activeGuests, totalGuestsToday }
 * - requestedGuests: today's requested visits
 * - activeGuests: all active visits
 * - weeklyTraffic: [{ day: 'Mon', value: N }, ...]
 * - autoAcceptGuests: boolean (from location, defaults true)
 */
partnerRouter.get('/analytics', protect, async (req, res) => {
  try {
    const partnerId = req.user.userId || req.user.id;
    if (!partnerId) {
      return res.status(400).json({ error: 'Missing partner id' });
    }

    // Load all visits for this partner (guestVisits.partnerId set in payments flow)
    const visitsSnap = await guestVisitsCol
      .where('partnerId', '==', partnerId)
      .get();

    const visits = visitsSnap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));

    const now = new Date();
    const dayNames = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    const todayName = dayNames[now.getDay()];

    // Requested guests for *today* (used for the "Requested" list)
    const requestedGuests = visits.filter((v) => {
      if (v.status !== 'requested') return false;

      // Prefer dayOfWeek if present
      if (v.dayOfWeek) {
        return v.dayOfWeek === todayName;
      }

      const ts = v.createdAt || v.startTime;
      if (ts && typeof ts.toDate === 'function') {
        const dt = ts.toDate();
        return dt.toDateString() === now.toDateString();
      }
      return false;
    });

    // All active guests (used for "Currently in your bathroom")
    const activeGuests = visits.filter((v) => v.status === 'active');

    // Total guests today (any status, by date)
    const totalGuestsToday = visits.filter((v) => {
      if (v.dayOfWeek) {
        return v.dayOfWeek === todayName;
      }
      const ts = v.createdAt || v.startTime;
      if (ts && typeof ts.toDate === 'function') {
        const dt = ts.toDate();
        return dt.toDateString() === now.toDateString();
      }
      return false;
    }).length;

    const stats = {
      activeGuests: activeGuests.length,
      totalGuestsToday,
    };

    // Weekly traffic: group by day of week from createdAt (all-time for now)
    const weeklyCounts = {
      0: 0, // Sun
      1: 0, // Mon
      2: 0, // Tue
      3: 0, // Wed
      4: 0, // Thu
      5: 0, // Fri
      6: 0, // Sat
    };

    visits.forEach((v) => {
      const ts = v.createdAt || v.startTime;
      if (!ts || typeof ts.toDate !== 'function') return;
      const dt = ts.toDate();
      const dayIndex = dt.getDay(); // 0 = Sunday
      weeklyCounts[dayIndex] = (weeklyCounts[dayIndex] || 0) + 1;
    });

    const shortDayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

    const weeklyTraffic = order.map((idx) => ({
      day: shortDayLabels[idx],
      value: weeklyCounts[idx] || 0,
    }));

    // Auto-accept flag (for toggle in UI). Default true to keep auto on.
    let autoAcceptGuests = true;
    try {
      const locSnap = await locationsCol
        .where('owner', '==', partnerId)
        .limit(1)
        .get();

      if (!locSnap.empty) {
        const locData = locSnap.docs[0].data() || {};
        if (typeof locData.autoAcceptGuests === 'boolean') {
          autoAcceptGuests = locData.autoAcceptGuests;
        }
      }
    } catch (err) {
      console.error('Error reading autoAcceptGuests in /partner/analytics:', err);
    }

    return res.json({
      stats,
      requestedGuests,
      activeGuests,
      weeklyTraffic,
      autoAcceptGuests,
    });
  } catch (err) {
    console.error('GET /partner/analytics error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/partner/guests/:visitId/accept
 * Host/partner accepts a pending guest visit (status -> active).
 */
partnerRouter.post('/guests/:visitId/accept', protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { visitId } = req.params;

    const visitRef = guestVisitsCol.doc(visitId);
    const visitSnap = await visitRef.get();

    if (!visitSnap.exists) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    const visit = visitSnap.data() || {};
    if (visit.partnerId !== userId) {
      return res.status(403).json({
        error: 'You are not allowed to manage this visit',
      });
    }

    if (visit.status !== 'pending' && visit.status !== 'requested') {
      return res.status(400).json({ error: 'Visit is not pending' });
    }

    const now = FieldValue.serverTimestamp();

    await visitRef.set(
      {
        status: 'active',
        updatedAt: now,
      },
      { merge: true }
    );

    return res.json({ id: visitId, status: 'active' });
  } catch (err) {
    console.error('POST /partner/guests/:visitId/accept error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/partner/guests/:visitId/end
 * Host/partner ends an active guest visit (status -> completed).
 */
partnerRouter.post('/guests/:visitId/end', protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { visitId } = req.params;

    const visitRef = guestVisitsCol.doc(visitId);
    const visitSnap = await visitRef.get();

    if (!visitSnap.exists) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    const visit = visitSnap.data() || {};
    const locationId = visit.locationId;

    if (!locationId) {
      return res.status(400).json({ error: 'Visit is missing a locationId' });
    }

    const locRef = locationsCol.doc(locationId);
    const locSnap = await locRef.get();

    if (!locSnap.exists) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const locData = locSnap.data() || {};
    if (locData.owner !== userId) {
      return res.status(403).json({
        error: 'You are not allowed to manage visits for this location',
      });
    }

    if (visit.status !== 'active') {
      return res.status(400).json({ error: 'Visit is not currently active' });
    }

    const now = FieldValue.serverTimestamp();

    await visitRef.set(
      {
        status: 'completed',
        endTime: now,
        updatedAt: now,
      },
      { merge: true }
    );

    return res.json({ id: visitId, status: 'completed' });
  } catch (err) {
    console.error('POST /partner/guests/:visitId/end error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/partner/location
 * Creates/updates this partner's primary bathroom listing (used on PartnerHomeScreen).
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
      const userId = req.user.userId || req.user.id;
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
        id: locRef.id,
        location: loc,
      });
    } catch (err) {
      console.error('PUT /partner/location error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * POST /api/partner/onboard-link
 * Ensures a Stripe Connect account exists, then returns a hosted
 * onboarding link URL so the partner can finish setup in Stripe.
 */
partnerRouter.post('/onboard-link', protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    // get email from body or users collection
    let email = req.body.email;
    if (!email) {
      const userDoc = await usersCol.doc(userId).get();
      email = userDoc.exists ? userDoc.data().email : null;
    }
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // load partner doc
    const partnerRef = partnersCol.doc(userId);
    const partnerSnap = await partnerRef.get();
    const partnerData = partnerSnap.exists ? partnerSnap.data() : {};
    let { stripeAccountId } = partnerData;

    // 1) If no Stripe account yet, create one
    if (!stripeAccountId) {
      const account = await stripeService.createPartnerAccount(
        userId,
        email,
        req.body || {}
      );
      stripeAccountId = account.id;
      await partnerRef.set(
        {
          stripeAccountId,
          onboardingStatus: 'pending_verification',
        },
        { merge: true }
      );
    }

    const FRONTEND_URL =
      process.env.FRONTEND_URL || 'https://pay2pee.app';

    // 2) Create the hosted onboarding link
    const returnUrl = `${FRONTEND_URL}/partner`;
    const refreshUrl = `${FRONTEND_URL}/partner`;

    const link = await stripeService.createAccountOnboardingLink(
      stripeAccountId,
      returnUrl,
      refreshUrl
    );

    return res.json({ url: link.url, frontendUrl: FRONTEND_URL });
  } catch (err) {
    console.error('POST /partner/onboard-link error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Stripe onboarding link error' });
  }
});

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
      const userId = req.user.userId || req.user.id;
      const { isActive } = req.body;

      const snap = await locationsCol
        .where('owner', '==', userId)
        .limit(1)
        .get();

      if (snap.empty) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const locRef = snap.docs[0].ref;
      await locRef.set(
        {
          isActive,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.json({ success: true, isActive });
    } catch (err) {
      console.error('PUT /host/visibility error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * PUT /api/host/auto-accept
 * Updates autoAcceptGuests flag for a given location.
 */
hostRouter.put(
  '/auto-accept',
  protect,
  [
    body('locationId').notEmpty().withMessage('locationId is required'),
    body('autoAcceptGuests')
      .isBoolean()
      .withMessage('autoAcceptGuests must be true or false'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId || req.user.id;
      const { locationId, autoAcceptGuests } = req.body;

      const ref = locationsCol.doc(locationId);
      const snap = await ref.get();

      if (!snap.exists) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const loc = snap.data() || {};

      if (loc.owner !== userId) {
        return res.status(403).json({
          error: 'You are not allowed to update this location',
        });
      }

      await ref.set({ autoAcceptGuests }, { merge: true });

      const updated = await ref.get();
      const updatedLoc = updated.data() || {};
      return res.json({
        id: ref.id,
        autoAcceptGuests: !!updatedLoc.autoAcceptGuests,
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
      const partnerId = req.user.userId || req.user.id;
      const amount = Number(req.body.amountRequested);

      const transfer = await stripeService.initiateManualPayout(
        partnerId,
        amount
      );

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
