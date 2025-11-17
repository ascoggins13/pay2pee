// routes/guestVisitsRoutes.js
const express = require('express');
const protect = require('../middleware/protect');
const { admin, firestore } = require('../firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const db = firestore;
const router = express.Router();

/**
 * GET /api/guest/visits/current
 * Returns the most recent non-completed visit for this user,
 * plus queue position info for the location.
 */
router.get('/visits/current', protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Find most recent requested/active visit (limit a few and filter in code)
    const snap = await db
      .collection('guestVisits')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();

    if (snap.empty) {
      return res.json({ visit: null });
    }

    let visitDoc = null;
    snap.forEach((doc) => {
      const v = doc.data();
      if (v.status === 'requested' || v.status === 'active') {
        if (!visitDoc) visitDoc = { id: doc.id, ...v };
      }
    });

    if (!visitDoc) {
      return res.json({ visit: null });
    }

    const visit = visitDoc;

    // Compute queue position: count same-location visits with status requested/active
    // ordered by createdAt ascending
    const queueSnap = await db
      .collection('guestVisits')
      .where('locationId', '==', visit.locationId)
      .orderBy('createdAt', 'asc')
      .get();

    let position = 1;
    let ahead = 0;

    queueSnap.forEach((doc) => {
      const v = doc.data();
      if (doc.id === visit.id) return;

      if (v.status === 'requested' || v.status === 'active') {
        if (
          v.createdAt &&
          visit.createdAt &&
          v.createdAt.toMillis() <= visit.createdAt.toMillis()
        ) {
          ahead += 1;
          position += 1;
        }
      }
    });

    const response = {
      id: visit.id,
      status: visit.status,
      locationId: visit.locationId,
      locationName: visit.locationName,
      locationAddress: visit.locationAddress,
      price: visit.price,
      partnerId: visit.partnerId,
      queuePosition: position,
      guestsAhead: ahead,
      accessCode: visit.status === 'active' ? visit.accessCode || null : null,
      instructions:
        visit.status === 'active' ? visit.instructions || null : null,
      createdAt: visit.createdAt,
    };

    return res.json({ visit: response });
  } catch (err) {
    console.error('GET /guest/visits/current error:', err);
    return res.status(500).json({ error: 'Failed to load current pass' });
  }
});

/**
 * POST /api/guest/visits/confirm-session
 * Body: { sessionId }
 * Called from the frontend success page to create a guestVisit after Stripe payment.
 *
 * IMPORTANT: Your Stripe Checkout session must have:
 *   session.metadata.locationId set when you create it.
 */
router.post('/visits/confirm-session', protect, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user.userId;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    // Idempotency: see if we already created a visit for this session
    const existingSnap = await db
      .collection('guestVisits')
      .where('stripeSessionId', '==', sessionId)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      const doc = existingSnap.docs[0];
      const visit = { id: doc.id, ...doc.data() };
      return res.json({ success: true, visitId: visit.id, status: visit.status });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Session is not paid' });
    }

    const locationId = session.metadata && session.metadata.locationId;
    if (!locationId) {
      return res.status(400).json({ error: 'Missing locationId on session metadata' });
    }

    // Load location to determine partner, price, access code, etc.
    const locRef = db.collection('locations').doc(locationId);
    const locSnap = await locRef.get();

    if (!locSnap.exists) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const loc = locSnap.data();

    const partnerId = loc.owner;
    const autoAccept = !!loc.autoAcceptGuests;
    const status = autoAccept ? 'active' : 'requested';

    const price =
      loc.pricing && typeof loc.pricing.basePrice === 'number'
        ? loc.pricing.basePrice
        : typeof loc.price === 'number'
        ? loc.price
        : 0;

    const visitData = {
      userId,
      partnerId,
      locationId,
      status,
      locationName: loc.name || 'Bathroom',
      locationAddress: loc.address || '',
      price: Number(price),
      accessCode: autoAccept ? loc.accessCode || null : null,
      instructions: autoAccept ? loc.instructions || null : null,
      stripeSessionId: sessionId,
      paymentIntentId: session.payment_intent || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const visitRef = await db.collection('guestVisits').add(visitData);

    return res.json({ success: true, visitId: visitRef.id, status });
  } catch (err) {
    console.error('POST /guest/visits/confirm-session error:', err);
    return res.status(500).json({ error: 'Failed to confirm session' });
  }
});

module.exports = router;
