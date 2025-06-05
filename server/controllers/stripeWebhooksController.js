const User = require('../models/User');

exports.handleWebhook = async (event) => {
  const subscription = event.data.object;
  const customerId = subscription.customer;

  switch (event.type) {
    case 'customer.subscription.created':
      await User.updateOne(
        { stripeCustomerId: customerId },
        { 'subscription.status': 'active' }
      );
      break;

    case 'customer.subscription.deleted':
      await User.updateOne(
        { stripeCustomerId: customerId },
        { 'subscription.status': 'canceled' }
      );
      break;
  }
};