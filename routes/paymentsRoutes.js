// routes/paymentsRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth'); // assumes req.user = { id, email, stripeCustomerId? }
const payments = require('../controllers/paymentsController');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { firestore, admin } = require('../firebase-admin');

const router = express.Router();
const guestVisitsCol = firestore.collection('guestVisits');
const locationsCol = firestore.collection('locations');

/**
 * GET /api/payments/prices
 * Returns normalized active prices (id, name, amount, currency, interval, mode, popular, features[])
 */
router.get('/prices', async (_req, res) => {
  try {
    const data = await payments.listActivePrices();
    res.json(data);
  } catch (e) {
    console.error('prices error', e);
    res.status(500).json({ error: 'Failed to load prices' });
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
        user: req.user, // expects { id, email, stripeCustomerId? }
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
 * POST /api/payments/guest/checkout
 * Body: { locationId, price, name? }
 * Creates a Stripe Checkout Session for a single restroom visit
 * UPDATED: routes payment to partner's connected Stripe account with 30% platform fee
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
      const amountInCents = Math.round(Number(price) * 100);

      // 1) Fetch location to get partnerId
      const locSnap = await locationsCol.doc(locationId).get();
      if (!locSnap.exists) {
        return res.status(404).json({ error: 'Location not found' });
      }
      const location = locSnap.data();
      const partnerId = location.owner;

      if (!partnerId) {
        return res
          .status(400)
          .json({ error: 'Location missing partner owner' });
      }

      // 2) Fetch partner to get stripeAccountId (connected account)
      const partnerSnap = await firestore
        .collection('partners')
        .doc(partnerId)
        .get();
      if (!partnerSnap.exists) {
        return res.status(404).json({ error: 'Partner not found' });
      }

      const partnerData = partnerSnap.data();
      const stripeAccountId = partnerData.stripeAccountId;

      if (!stripeAccountId) {
        return res.status(400).json({
          error: 'Partner does not have a connected Stripe account yet',
        });
      }

      // 3) Apply your 30% platform fee
      const platformFeePercent = 0.30;
      const applicationFeeAmount = Math.round(
        amountInCents * platformFeePercent
      );

      // 4) Create destination-charge Checkout Session
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: amountInCents,
              product_data: {
                name: name || 'Pay2Pee restroom pass',
              },
            },
            quantity: 1,
          },
        ],
        customer_email: req.user.email,
        metadata: {
          type: 'guest_pass',
          locationId,
          partnerId,
          userId: req.user.id || req.user.userId || '',
        },
        payment_intent_data: {
          application_fee_amount: applicationFeeAmount, // your 30% cut
          transfer_data: {
            destination: stripeAccountId, // partner receives the rest
          },
        },
        // HashRouter-aware success/cancel URLs
        success_url: `${process.env.CLIENT_URL}/#/mypass?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/#/`,
      });

      res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
      console.error('guest checkout error:', err);
      res.status(500).json({
        error: err.message || 'Failed to create guest checkout session',
      });
    }
  }
);

/**
 * POST /api/payments/portal
 * Opens Stripe Billing Portal for the logged-in user (must have stripeCustomerId)
 */
router.post('/portal', protect, async (req, res) => {
  try {
    const portal = await payments.createBillingPortalSession({ user: req.user });
    res.json({ url: portal.url });
  } catch (err) {
    console.error('billing portal error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to create billing portal session' });
  }
});

/**
 * (Optional) GET /api/payments/config
 * Returns your publishable key to the client (handy for sanity checks)
 */
router.get('/config', (_req, res) => {
  res.json({
    publishableKey:
      process.env.REACTIVE_APP_STRIPE_PK ||
      process.env.REACT_APP_STRIPE_PK ||
      '',
  });
});

/**
 * GET /api/payments/guest/session/:sessionId
 *
 * Used by MyPass page:
 *  - Verifies session with Stripe
 *  - Creates a guestVisits document if not already created for this session
 *  - Applies auto-accept + duration
 *  - Lazily expires visits if time is up
 *  - Returns session, location, and visit info
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
        .json({ error: 'Session is missing locationId metadata' });
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
              endTime: admin.firestore.Timestamp.fromDate(expDate),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
      visitDoc = { id: doc.id, ...data };
    } else {
      // No visit yet for this session
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

