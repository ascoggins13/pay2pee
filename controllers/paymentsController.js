const stripeService = require('../services/stripeService');
const User = require('../models/User');

exports.createSubscription = async (req, res) => {
  try {
    const { planId, paymentMethodId } = req.body;
    const user = req.user; // From auth middleware

    // 1. Create Stripe subscription
    const { customerId, subscription } = await stripeService.createSubscription({
      userId: user._id,
      email: user.email,
      planId,
      paymentMethodId
    });

    // 2. Update user in MongoDB
    await User.findByIdAndUpdate(user._id, {
      stripeCustomerId: customerId,
      subscription: {
        type: planId,
        expiresAt: new Date(subscription.current_period_end * 1000),
        autoRenew: true
      }
    });

    res.json({ success: true, subscription });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};