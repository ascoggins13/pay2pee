// routes/partnerRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const axios = require('axios');

const protect = require('../middleware/protect');
const { admin, firestore } = require('../firebase-admin');
const stripeService = require('../services/stripeService');
const { createNotification } = require('./services/notificationService');

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

    const { lat, lng } = res.data.results[0].geometry.location;
    return { lat, lng };
  } catch (err) {
    console.error('Error geocoding address:', err.response?.data || err.message);
    return null;
  }
}

const partnerRouter = express.Router();
const hostRouter = express.Router();

/**
 * GET /api/partner/profile
 * Returns partner profile with Stripe + location info, plus a quick snapshot of their balances.
 */
partnerRouter.get('/profile', protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [userDoc, partnerDoc, locSnap] = await Promise.all([
      usersCol.doc(userId).get(),
      partnersCol.doc(userId).get(),
      locationsCol.where('owner', '==', userId).limit(1).get(),
    ]);

    if (!partnerDoc.exists) {
      return res.status(404).json({ error: 'Partner profile not found' });
    }

    const user = userDoc.exists ? userDoc.data() : {};
    const partner = partnerDoc.data() || {};

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
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (err) {
        console.error('Error refreshing Stripe account status:', err);
      }
    }

    const response = {
      user: {
        id: userId,
        displayName: user.displayName || '',
        email: user.email || '',
      },
      partner: {
        id: partnerDoc.id,
        businessName: partner.businessName || '',
        phone: partner.phone || '',
        stripeAccountId: partner.stripeAccountId || null,
        stripeStatus,
        lifetimeEarnings: partner.lifetimeEarnings || 0,
        stripeBalance: partner.stripeBalance || 0,
        pendingPayout: partner.pendingPayout || 0,
        lastPayoutDate: partner.lastPayoutDate || null,
      },
      location: hasLocation
        ? {
            id: locId,
            name: loc.name || '',
            address: loc.address || '',
            description: loc.description || '',
            autoAcceptGuests: !!loc.autoAcceptGuests,
            coordinates: loc.coordinates || null,
          }
        : null,
    };

    return res.json(response);
  } catch (err) {
    console.error('GET /partner/profile error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/partner/profile
 * Creates or updates the partner profile with basic info.
 */
partnerRouter.post(
  '/profile',
  protect,
  [
    body('businessName').notEmpty().withMessage('Business name is required'),
    body('phone').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const { businessName, phone } = req.body;

      const partnerData = {
        businessName,
        phone: phone || '',
        updatedAt: FieldValue.serverTimestamp(),
      };

      await partnersCol.doc(userId).set(
        {
          ...partnerData,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const partnerDoc = await partnersCol.doc(userId).get();

      return res.json({
        partner: { id: partnerDoc.id, ...partnerDoc.data() },
      });
    } catch (err) {
      console.error('POST /partner/profile error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * POST /api/partner/locations
 * Creates or updates a partner location.
 */
partnerRouter.post(
  '/locations',
  protect,
  [
    body('name').notEmpty().withMessage('Location name is required'),
    body('address').notEmpty().withMessage('Address is required'),
    body('description').optional().isString(),
    body('autoAcceptGuests').optional().isBoolean(),
    body('locationId').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const { name, address, description, autoAcceptGuests, locationId } =
        req.body;

      let ref;
      let existing = null;

      if (locationId) {
        ref = locationsCol.doc(locationId);
        const snap = await ref.get();
        if (!snap.exists) {
          return res.status(404).json({ error: 'Location not found' });
        }
        existing = snap.data() || {};
      }

      let coordinates = existing?.coordinates || null;
      const addressChanged =
        existing && address && address !== (existing.address || '');

      if (!existing || addressChanged || !coordinates) {
        const geo = await geocodeAddress(address || existing?.address);
        if (geo) {
          coordinates = geo;
        }
      }

      const baseData = {
        owner: userId,
        name: name !== undefined ? name : existing?.name || '',
        address: address !== undefined ? address : existing?.address || '',
        description:
          description !== undefined ? description : existing?.description || '',
        autoAcceptGuests:
          typeof autoAcceptGuests === 'boolean'
            ? autoAcceptGuests
            : !!existing?.autoAcceptGuests,
        coordinates: coordinates || null,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (locationId) {
        await ref.set(baseData, { merge: true });
      } else {
        ref = await locationsCol.add({
          ...baseData,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      const updated = await ref.get();
      return res.json({
        location: { id: ref.id, ...updated.data() },
      });
    } catch (err) {
      console.error('POST /partner/locations error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * GET /api/partner/locations
 * Lists all locations for the logged-in partner.
 */
partnerRouter.get('/locations', protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    const snap = await locationsCol.where('owner', '==', userId).get();
    const locations = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      locations.push({
        id: doc.id,
        name: data.name || '',
        address: data.address || '',
        description: data.description || '',
        autoAcceptGuests: !!data.autoAcceptGuests,
        coordinates: data.coordinates || null,
      });
    });

    return res.json({ locations });
  } catch (err) {
    console.error('GET /partner/locations error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/partner/analytics
 * Basic analytics for the partner: visits, statuses, revenue.
 */
partnerRouter.get('/analytics', protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    const snap = await guestVisitsCol.where('partnerId', '==', userId).get();

    let totalVisits = 0;
    let activeVisits = 0;
    let completedVisits = 0;
    let expiredVisits = 0;
    let totalRevenue = 0;

    snap.forEach((doc) => {
      const v = doc.data() || {};
      totalVisits += 1;

      if (v.status === 'active') activeVisits += 1;
      if (v.status === 'completed') completedVisits += 1;
      if (v.status === 'expired') expiredVisits += 1;

      if (typeof v.amountTotal === 'number') {
        totalRevenue += v.amountTotal;
      }
    });

    const totalRevenueDollars = totalRevenue / 100;

    return res.json({
      summary: {
        totalVisits,
        activeVisits,
        completedVisits,
        expiredVisits,
        totalRevenue: totalRevenueDollars,
      },
    });
  } catch (err) {
    console.error('GET /partner/analytics error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/partner/guests
 * Lists visits for a specific partner, optionally filtered by status.
 */
partnerRouter.get('/guests', protect, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status } = req.query;

    let query = guestVisitsCol.where('partnerId', '==', userId);

    if (status) {
      query = query.where('status', '==', status);
    }

    const snap = await query.orderBy('createdAt', 'desc').limit(50).get();

    const visits = [];
    snap.forEach((doc) => {
      const v = doc.data() || {};
      visits.push({
        id: doc.id,
        ...v,
      });
    });

    return res.json({ visits });
  } catch (err) {
    console.error('GET /partner/guests error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/partner/guests/:visitId/accept
 * Host/partner accepts a pending guest visit (status -> active).
 */
partnerRouter.post('/guests/:visitId/accept', protect, async (req, res) => {
  try {
    const userId = req.user.userId;
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

    if (visit.status !== 'pending') {
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
    const userId = req.user.userId;
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

    // Notification: guest thank-you after host ends visit
    const guestUserId = visit.userId;
    if (guestUserId) {
      try {
        await createNotification({
          userId: guestUserId,
          userType: 'guest',
          type: 'GUEST_THANK_YOU',
          title: 'Thanks for your visit',
          body: `Thanks for visiting ${locData.name || 'this bathroom'}.`,
          data: {
            guestVisitId: visitId,
            locationId,
          },
        });
      } catch (err2) {
        console.error('Error creating guest thank-you notification:', err2);
      }
    }

    return res.json({ id: visitId, status: 'completed' });
  } catch (err) {
    console.error('POST /partner/guests/:visitId/end error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/partner/onboard
 * Optional: collects some KYC info and calls stripeService.createOrUpdateConnectedAccount(...)
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
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const {
        email,
        firstName,
        lastName,
        ssnLast4,
        dobDay,
        dobMonth,
        dobYear,
      } = req.body;

      const userDoc = await usersCol.doc(userId).get();
      const user = userDoc.data() || {};

      const params = {
        email: email || user.email,
        firstName,
        lastName,
        ssnLast4,
        dobDay,
        dobMonth,
        dobYear,
      };

      const account = await stripeService.createOrUpdateConnectedAccount(
        userId,
        params
      );

      return res.json({ account });
    } catch (err) {
      console.error('POST /partner/onboard error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * GET /api/host/stripe-balance
 * Returns partner's Stripe balance summary for their connected account.
 */
hostRouter.get('/stripe-balance', protect, async (req, res) => {
  try {
    const partnerId = req.user.userId;

    const doc = await partnersCol.doc(partnerId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Partner profile not found' });
    }

    const pdata = doc.data() || {};
    const stripeAccountId = pdata.stripeAccountId;

    if (!stripeAccountId) {
      return res
        .status(400)
        .json({ error: 'Stripe account not linked for this partner' });
    }

    const balance = await stripeService.getStripeBalance(stripeAccountId);

    const totalAvailable = (balance.available?.[0]?.amount || 0) / 100;
    const totalPending = (balance.pending?.[0]?.amount || 0) / 100;

    await partnersCol.doc(partnerId).set(
      {
        stripeBalance: totalAvailable,
        pendingPayout: totalPending,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({
      stripeBalance: totalAvailable,
      pendingPayout: totalPending,
    });
  } catch (err) {
    console.error('GET /host/stripe-balance error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

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
      const partnerId = req.user.userId;
      const { locationId, autoAcceptGuests } = req.body;

      const ref = locationsCol.doc(locationId);
      const snap = await ref.get();

      if (!snap.exists) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const loc = snap.data() || {};

      if (loc.owner !== partnerId) {
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
      const partnerId = req.user.userId;
      const amount = Number(req.body.amountRequested);

      const transfer = await stripeService.initiateManualPayout(
        partnerId,
        amount
      );

      const doc = await partnersCol.doc(partnerId).get();
      const pdata = doc.exists ? doc.data() : {};

      // Notification: partner payout sent
      try {
        await createNotification({
          userId: partnerId,
          userType: 'partner',
          type: 'PARTNER_PAYOUT_AVAILABLE',
          title: 'Payout sent',
          body: `Your payout of $${amount.toFixed(2)} is on its way to your bank account.`,
          data: {
            payoutTransferId: transfer.id,
            stripeAccountId: pdata.stripeAccountId || null,
          },
        });
      } catch (err2) {
        console.error('Error creating payout notification:', err2);
      }

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
