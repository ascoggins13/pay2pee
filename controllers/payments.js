// server/controllers/payments.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.createSubscription = async (req, res) => {
  try {
    const { planId, paymentMethodId } = req.body;
   
    // Create customer if doesn't exist
    let customer;
    if (req.user.stripeCustomerId) {
      customer = await stripe.customers.retrieve(req.user.stripeCustomerId);
    } else {
      customer = await stripe.customers.create({
        email: req.user.email,
        payment_method: paymentMethodId,
        invoice_settings: {
          default_payment_method: paymentMethodId
        }
      });
      // Save customer ID to user in DB
    }
   
    // Create subscription based on plan
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: getStripePriceId(planId) }],
      expand: ['latest_invoice.payment_intent']
    });
   
    // Save subscription to user in DB
    // ...
   
    res.json({ success: true, subscription });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};