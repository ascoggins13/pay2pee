// routes/paymentsRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const payments = require('../controllers/paymentsController');

const router = express.Router();

/**
 * GET /api/payments/prices
 * Returns normalized active prices (id, name, amount, currency, interval, mode, popular, features[]).
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
 * Creates a Stripe Checkout Session in "subscription" mode.
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
        user: req.user,
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
 * Creates a Stripe Checkout Session in "payment" mode (single-use based on static Stripe Price).
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
 * POST /api/payments/portal
 * Opens Stripe Billing Portal for the logged-in user.
 */
router.post('/portal', protect, async (req, res) => {
  try {
    const portal = await payments.createBillingPortalSession({ user: req.user });
    res.json({ url: portal.url });
  } catch (err) {
    console.error('billing portal error:', err);
    res.status(400).json({ error: err.message || 'Failed to create billing portal session' });
  }
});

/**
 * GET /api/payments/config
 * Returns your publishable key to the client (optional).
 */
router.get('/config', (_req, res) => {
  res.json({
    publishableKey:
      process.env.REACTIVE_APP_STRIPE_PK || process.env.REACT_APP_STRIPE_PK || '',
  });
});

/**
 * NEW: POST /api/payments/checkout
 * Body: { locationId: string }
 * Creates a Stripe Checkout Session with a DYNAMIC amount based on Firestore location.price.
 * Used by HomeScreen "Confirm & Continue" for live locations.
 */
router.post(
  '/checkout',
  protect,
  [body('locationId', 'locationId is required').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { locationId } = req.body;
      const session = await payments.createLocationCheckoutSession({
        locationId,
        user: req.user,
      });
      res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
      console.error('pay-per-visit checkout error:', err);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  }
);

module.exports = router;
