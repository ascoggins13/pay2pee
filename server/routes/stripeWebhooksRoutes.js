const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const webhooksController = require('../controllers/stripeWebhooksController');

const router = express.Router();

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    webhooksController.handleWebhook(event);
    res.json({ received: true });
  }
);

module.exports = router;
