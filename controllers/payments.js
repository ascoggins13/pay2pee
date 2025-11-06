// controllers/payments.js (Firestore version)
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const db = admin.firestore();
const usersCol = db.collection('users');

// Map your planId -> Stripe Price ID
function getStripePriceId(planId) {
  // keep your existing mapping here
  // e.g.: if (planId === 'weekly') return process.env.STRIPE_PRICE_WEEKLY;
  //       if (planId === 'monthly') return process.env.STRIPE_PRICE_MONTHLY;
  // Fallback:
  return process.env.STRIPE_DEFAULT_PRICE_ID;
}

exports.createSubscription = async (req, res) => {
  try {
    const { planId, paymentMethodId } = req.body;
    if (!planId || !paymentMethodId) {
      return res.status(400).json({ error: 'Missing planId or paymentMethodId' });
    }

    // Load the Firestore user
    const userId = req.user.userId; // set by protect middleware
    const userRef = usersCol.doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userSnap.data();

    // 1) Ensure Stripe customer
    let customerId = user.stripeCustomerId;
    if (customerId) {
      // make sure it still exists
      try {
        await stripe.customers.retrieve(customerId);
      } catch {
        customerId = null;
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId }
      });
      customerId = customer.id;
      await userRef.set({ stripeCustomerId: customerId }, { merge: true });
    }

    // 2) Attach payment method & set default
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    // 3) Create subscription
    const priceId = getStripePriceId(planId);
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent']
    });

    // 4) Save subscription info to Firestore
    await userRef.set(
      {
        subscription: {
          id: subscription.id,
          status: subscription.status || 'incomplete',
          planId,
          priceId,
          currentPeriodEnd: subscription.current_period_end || null
        }
      },
      { merge: true }
    );

    return res.json({ success: true, subscription });
  } catch (err) {
    console.error('createSubscription error:', err);
    return res.status(500).json({ error: err.message || 'Stripe error' });
  }
};