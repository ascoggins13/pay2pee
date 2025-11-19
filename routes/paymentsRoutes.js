// routes/paymentsRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth'); // assumes req.user = { id, email, stripeCustomerId? }
const payments = require('../controllers/paymentsController');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { firestore, admin } = require('../firebase-admin');

const router = express.Router();

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
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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
      res.status(500).json({ error: 'Failed to create subscription checkout session' });
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
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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
      res.status(500).json({ error: 'Failed to create one-time checkout session' });
    }
  }
);

/**
 * POST /api/payments/guest/checkout
 * Body: { locationId, price, name? }
 * Creates a Stripe Checkout Session for a single restroom visit
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
          userId: req.user.id || req.user.userId || '',
        },
        // 🔥 FIXED — hash route added
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

    // Optional: make sure the session is for this user
    if (
      session.customer_email &&
      req.user.email &&
      session.customer_email.toLowerCase() !== req.user.email.toLowerCase()
    ) {
      return res.status(403).json({ error: 'Session does not belong to this user' });
    }

    const metadata = session.metadata || {};
    const locationId = metadata.locationId;
    const userId = metadata.userId || req.user.id || req.user.userId;

    if (!locationId) {
      return res.status(400).json({ error: 'Session is missing locationId metadata' });
    }

    // 2) Fetch location info
    const locRef = firestore.collection('locations').doc(locationId);
    const locSnap = await locRef.get();

    if (!locSnap.exists) {
      return res.status(404).json({ error: 'Location not found for this pass' });
    }

    const location = { id: locSnap.id, ...locSnap.data() };

    // 3) Create or fetch guest visit in Firestore
    const guestVisitsCol = firestore.collection('guestVisits');

    // Try to find an existing visit for this Stripe session
    const existingVisitSnap = await guestVisitsCol
      .where('stripeSessionId', '==', session.id)
      .limit(1)
      .get();

    let visitStatus = "pending";
    if (session.payment_status === "paid") {
      visitStatus = autoAcceptGuests ? "active" : "pending";
    
      const visitData = {
        stripeSessionId: session.id,
        userId,
        locationId,
        status: session.payment_status === 'paid' ? 'active' : 'pending', // basic state for now
        amountTotal: session.amount_total,
        currency: session.currency,
        createdAt: now,
        updatedAt: now,
      };

      const newRef = await guestVisitsCol.add(visitData);
      const newSnap = await newRef.get();
      visitDoc = { id: newRef.id, ...newSnap.data() };
    } else {
      const doc = existingVisitSnap.docs[0];
      visitDoc = { id: doc.id, ...doc.data() };
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

module.exports = router;
