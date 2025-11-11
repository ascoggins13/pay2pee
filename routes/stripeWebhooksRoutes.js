// routes/stripeWebhooksRoutes.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { handleStripeEvent } = require('../controllers/stripeWebhooksController');

// IMPORTANT: Stripe needs the raw body
router.use(express.raw({ type: 'application/json' }));

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    await handleStripeEvent(event);
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

module.exports = router;