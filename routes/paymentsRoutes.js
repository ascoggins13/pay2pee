// routes/paymentsRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const protect = require('../middleware/protect');
const payments = require('../controllers/paymentsController');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { firestore, admin } = require('../firebase-admin');
const { createNotification } = require('../services/notificationService');

const router = express.Router();
const guestVisitsCol = firestore.collection('guestVisits');
const locationsCol = firestore.collection('locations');

/**
 * GET /api/payments/prices
 * Returns normalized active prices (id, name, amount, currency, interval, mode, popular, features[])
 */
router.get('/prices', protect, async (req, res) => {
  try {
    const prices = await payments.getNormalizedPrices();
    res.json({ prices });
  } catch (err) {
    console.error('Error fetching prices:', err);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

/**
 * POST /api/payments/subscriptions
 * Body: { priceId: string }
 * Creates a Stripe Checkout Session in "subscription" mode
 */
router.post(
  '/subscriptions',
  protect,
  [body('priceId', 'priceId is required').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const { priceId } = req.body;
      const session = await payments.createCheckoutSession({
        priceId,
        mode: 'subscription',
        user: req.user,
      });
      res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
      console.error('subscription checkout error:', err);
      res
        .status(500)
        .json({ error: 'Failed to create subscription checkout session' });
    }
  }
);

/**
 * POST /api/payments/one-time
 * Body: { priceId: string }
 * Creates a Stripe Checkout Session in "payment" mode (single-use pass)
 */
router.post(
  '/one-time',
  protect,
  [body('priceId', 'priceId is required').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const { priceId } = req.body;
      const session = await payments.createCheckoutSession({
        priceId,
        mode: 'payment',
        user: req.user,
      });
      res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
      console.error('one-time checkout error:', err);
      res
        .status(500)
        .json({ error: 'Failed to create one-time checkout session' });
    }
  }
);

/**
 * GET /api/payments/subscriptions/:sessionId
 * Returns info about a just-completed subscription checkout session.
 */
router.get('/subscriptions/:sessionId', protect, async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Quick sanity check to ensure user is the rightful owner of this session
    if (
      session.customer_email &&
      req.user.email &&
      session.customer_email.toLowerCase() !== req.user.email.toLowerCase()
    ) {
      return res
        .status(403)
        .json({ error: 'Session does not belong to this user' });
    }

    // Minimal response including subscription details
    res.json({
      sessionId: session.id,
      subscriptionId: session.subscription,
      status: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
    });
  } catch (err) {
    console.error('subscription session lookup error:', err);
    res
      .status(500)
      .json({ error: 'Failed to load subscription session details' });
  }
});

/**
 * POST /api/payments/guest/checkout
 * Body: { locationId: string, price: number, name?: string }
 * Creates a Stripe Checkout Session in "payment" mode for a bathroom visit.
 */
router.post(
  '/guest/checkout',
  protect,
  [
    body('locationId', 'locationId is required').notEmpty(),
    body('price', 'price must be a positive number').isFloat({ min: 0.5 }),
    body('name').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { locationId, price, name } = req.body;
      const userId = req.user.id || req.user.userId;
      const email = req.user.email;

      if (!userId) {
        return res.status(400).json({ error: 'Missing user id' });
      }

      if (!process.env.CLIENT_URL) {
        console.warn('CLIENT_URL is not set in environment variables');
      }

      // Optional: ensure location exists
      const locSnap = await locationsCol.doc(locationId).get();
      if (!locSnap.exists) {
        return res.status(404).json({ error: 'Location not found' });
      }
      const loc = locSnap.data() || {};

      const unitAmount = Math.round(Number(price) * 100);

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        customer_email: email || undefined,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: name || `Bathroom pass - ${loc.name || 'location'}`,
              },
              unit_amount: unitAmount,
            },
            quantity: 1,
          },
        ],
        metadata: {
          locationId,
          userId,
        },
        success_url: `${process.env.CLIENT_URL}/mypass?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/home`,
      });

      return res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
      console.error('guest checkout error:', err);
      return res
        .status(500)
        .json({ error: err.message || 'Failed to create guest checkout session' });
    }
  }
);

/**
 * GET /api/payments/guest/session/:sessionId
 *
 * 1) Validates the Checkout Session belongs to the logged-in user.
 * 2) Resolves the associated location from Firestore.
 * 3) Either:
 *    - Returns an existing visit (if one is already linked to this session), OR
 *    - Creates a new visit if payment is complete and no visit exists.
 */
router.get('/guest/session/:sessionId', protect, async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    // 1) Fetch Checkout Session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Ensure the session belongs to this user
    if (
      session.customer_email &&
      req.user.email &&
      session.customer_email.toLowerCase() !== req.user.email.toLowerCase()
    ) {
      return res
        .status(403)
        .json({ error: 'Session does not belong to this user' });
    }

    const metadata = session.metadata || {};
    const locationId = metadata.locationId;
    const userId = metadata.userId || req.user.id || req.user.userId;

    if (!locationId) {
      return res
        .status(400)
        .json({ error: 'Session metadata missing locationId' });
    }

    // 2) Fetch location info
    const locRef = locationsCol.doc(locationId);
    const locSnap = await locRef.get();

    if (!locSnap.exists) {
      return res.status(404).json({ error: 'Location not found for this pass' });
    }

    const location = { id: locSnap.id, ...locSnap.data() };
    const autoAcceptGuests = !!location.autoAcceptGuests;
    const partnerId = location.owner || null;

    // 3) Create or fetch guest visit in Firestore
    const existingVisitSnap = await guestVisitsCol
      .where('stripeSessionId', '==', session.id)
      .limit(1)
      .get();

    const now = admin.firestore.Timestamp.now();
    const dayNames = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    const nowJs = new Date();
    const todayName = dayNames[nowJs.getDay()];

    let visitDoc;

    // Helper to lazily expire a visit if it's past expiresAt
    const maybeExpireVisit = async (docId, data) => {
      if (
        data.status === 'active' &&
        data.expiresAt &&
        typeof data.expiresAt.toDate === 'function'
      ) {
        const expDate = data.expiresAt.toDate();
        if (new Date() > expDate) {
          await guestVisitsCol.doc(docId).set(
            {
              status: 'expired',
              updatedAt: admin.firestore.Timestamp.now(),
            },
            { merge: true }
          );
          return {
            ...data,
            status: 'expired',
            endTime: admin.firestore.Timestamp.fromDate(expDate),
          };
        }
      }
      return data;
    };

    if (!existingVisitSnap.empty) {
      // Visit already exists for this Stripe session
      const doc = existingVisitSnap.docs[0];
      let data = doc.data() || {};
      data = await maybeExpireVisit(doc.id, data);

      visitDoc = {
        id: doc.id,
        ...data,
      };
    } else {
      // No existing visit – check if the session is fully paid
      const isPaid =
        session.payment_status === 'paid' ||
        session.payment_status === 'no_payment_required';

      if (!isPaid) {
        // Not paid yet – no visit. Still return session + location.
        return res.json({
          session: {
            id: session.id,
            status: session.payment_status,
            amountTotal: session.amount_total,
            currency: session.currency,
          },
          location,
          visit: null,
        });
      }

      // Payment is complete – create a new visit
      // P2P VIP: short, high-rotation window under 10 minutes
      const maxDurationMinutes = 8; // tweak here if you ever want 7 / 9 / 10
      const expiresAt = admin.firestore.Timestamp.fromMillis(
        now.toMillis() + maxDurationMinutes * 60 * 1000
      );

      const visitStatus = autoAcceptGuests ? 'active' : 'pending';

      const visitData = {
        stripeSessionId: session.id,
        userId,
        locationId,
        partnerId,
        status: visitStatus, // "active" or "pending"
        amountTotal: session.amount_total,
        currency: session.currency,

        startTime: now,
        endTime: null,
        maxDurationMinutes,
        expiresAt,

        dayOfWeek: todayName,
        passType: 'one-time',

        createdAt: now,
        updatedAt: now,
      };

      const newRef = await guestVisitsCol.add(visitData);
      const newSnap = await newRef.get();
      visitDoc = { id: newRef.id, ...newSnap.data() };

      // Notifications: guest booking confirmed, time warning, and partner new booking
      try {
        // Guest: booking confirmed
        await createNotification({
          userId,
          userType: 'guest',
          type: 'GUEST_BOOKING_CONFIRMED',
          title: 'Bathroom booked',
          body: `Your visit to ${location.name || 'this bathroom'} is confirmed.`,
          data: {
            guestVisitId: newRef.id,
            locationId,
          },
        });

        // Guest: time almost up (frontend can highlight based on expiresAt)
        await createNotification({
          userId,
          userType: 'guest',
          type: 'GUEST_TIME_WARNING',
          title: 'Time almost up',
          body: `Your visit to ${location.name || 'this bathroom'} is almost over.`,
          data: {
            guestVisitId: newRef.id,
            locationId,
            expiresAt,
          },
        });

        // Partner: new booking
        if (partnerId) {
          await createNotification({
            userId: partnerId,
            userType: 'partner',
            type: 'PARTNER_NEW_BOOKING',
            title: 'New booking',
            body: 'A guest just booked your bathroom.',
            data: {
              guestVisitId: newRef.id,
              locationId,
            },
          });
        }
      } catch (notifyErr) {
        console.error('Error creating booking notifications:', notifyErr);
      }
    }

    return res.json({
      session: {
        id: session.id,
        status: session.payment_status, // 'paid', 'unpaid', 'no_payment_required'
        amountTotal: session.amount_total,
        currency: session.currency,
      },
      location,
      visit: visitDoc,
    });
  } catch (err) {
    console.error('guest session lookup error:', err);
    return res.status(500).json({
      error: err.message || 'Failed to load session / pass details',
    });
  }
});

/**
 * POST /api/payments/guest/visit/:visitId/end
 *
 * Guest manually ends an active visit (e.g. leaves early).
 */
router.post('/guest/visit/:visitId/end', protect, async (req, res) => {
  const { visitId } = req.params;
  const userId = req.user.id || req.user.userId;

  try {
    const visitRef = guestVisitsCol.doc(visitId);
    const snap = await visitRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    const visit = snap.data() || {};

    if (visit.userId !== userId) {
      return res
        .status(403)
        .json({ error: 'You are not allowed to end this visit' });
    }

    if (visit.status !== 'active') {
      return res.status(400).json({ error: 'Visit is not active' });
    }

    const now = admin.firestore.Timestamp.now();

    await visitRef.set(
      {
        status: 'completed',
        endTime: now,
        updatedAt: now,
      },
      { merge: true }
    );

    // Notification: guest thank-you after visit
    try {
      await createNotification({
        userId,
        userType: 'guest',
        type: 'GUEST_THANK_YOU',
        title: 'Thanks for your visit',
        body: 'Thanks for using Pay2Pee today.',
        data: {
          guestVisitId: visitId,
          locationId: visit.locationId || null,
        },
      });
    } catch (notifyErr) {
      console.error('Error creating thank-you notification:', notifyErr);
    }

    return res.json({
      id: visitId,
      status: 'completed',
      endTime: now,
    });
  } catch (err) {
    console.error('End visit error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to end visit' });
  }
});

module.exports = router;

