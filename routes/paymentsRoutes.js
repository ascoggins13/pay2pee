const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth'); // Destructure if needed
const paymentsController = require('../controllers/paymentsController');
const { body, validationResult } = require('express-validator');

// @route   POST /api/payments/subscriptions
// @desc    Create a new subscription
// @access  Private
router.post(
  '/subscriptions',
  protect,
  [
    body('priceId', 'Price ID is required').not().isEmpty(),
    body('paymentMethodId', 'Payment method is required').not().isEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      await paymentsController.createSubscription(req, res);
    } catch (err) {
      console.error('Subscription error:', err);
      res.status(500).json({ 
        error: 'Subscription creation failed',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  }
);

module.exports = router;