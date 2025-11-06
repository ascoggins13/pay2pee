// controllers/paymentsController.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

const db = admin.firestore();

/**
 * Normalize Stripe Price → UI shape
 * [{ id, name, amount, currency, interval, mode, popular, features[] }]
 * You can drive "popular" and "features_csv" from Product metadata in Stripe.
 */
async function listActivePrices() {
  const prices = await stripe.prices.list({
    active: true,
    expand: ['data.product'],
    limit: 100,
  });

  const normalized = prices.data
    .filter((p) => p.product && p.product.active) // only active products
    .map((p) => {
      const product = p.product;
      const interval = p.recurring?.interval || null; // 'day' | 'week' | 'month' | 'year' | null
      const mode = p.type === 'one_time' ? 'payment' : 'subscription';

      // Optional: features via metadata
      let features = [];
      if (Array.isArray(product?.metadata?.features)) {
        features = product.metadata.features;
      } else if (product?.metadata?.features_csv) {
        features = product.metadata.features_csv.split(',').map((s) => s.trim()).filter(Boolean);
      }

      const popular = (product?.metadata?.popular || '').toString().toLowerCase() === 'true';

      return {
        id: p.id,
        name: product?.name || 'Plan',
        amount: p.unit_amount || 0, // cents
        currency: (p.currency || 'usd').toUpperCase(),
        interval,
        mode,
        popular,
        features,
      };
    });

  // Optional: custom ordering (e.g., put one-time at end or start)
  return normalized.sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === 'payment' ? 1 : -1; // subscriptions first
    // Then by amount ascending:
    return (a.amount || 0) - (b.amount || 0);
  });
}

/**
 * Create a Stripe Checkout Session (subscription or one-time)
 * opts: { priceId, mode: 'subscription'|'payment', user: { id, email, stripeCustomerId? } }
 */
async function createCheckoutSession({ priceId, mode, user }) {
  if (!priceId) throw new Error('priceId is required');
  if (!mode) {
    // Infer mode from Price if omitted
    const price = await stripe.prices.retrieve(priceId);
    mode = price.type === 'one_time' ? 'payment' : 'subscription';
  }

  // Prefer a persisted Stripe Customer for the user (if you store it)
  let sessionParams = {
    mode,
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.id, // webhook uses this to update Firestore
    allow_promotion_codes: true,
    success_url: `${process.env.CLIENT_URL}/subscription-success?sid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.CLIENT_URL}/subscription-cancelled`,
  };

  if (user.stripeCustomerId) {
    sessionParams.customer = user.stripeCustomerId;
  } else if (user.email) {
    sessionParams.customer_email = user.email; // Stripe will create a Customer on success
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  // (Optional) If you didn’t have a customerId and want to guarantee one, you can
  // create it up front and pass `customer` instead of `customer_email`.
  return session;
}

/**
 * Create a Billing Portal session for the logged-in user
 * -> requires users/{id}.stripeCustomerId
 */
async function createBillingPortalSession({ user }) {
  // You can keep stripeCustomerId on req.user (populate in protect middleware)
  let stripeCustomerId = user.stripeCustomerId;

  if (!stripeCustomerId) {
    // fallback to Firestore lookup
    const userDoc = await db.collection('users').doc(user.id).get();
    if (!userDoc.exists) throw new Error('User not found');
    stripeCustomerId = userDoc.data().stripeCustomerId;
  }

  if (!stripeCustomerId) {
    throw new Error('No Stripe customer on file for this user');
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${process.env.CLIENT_URL}/account`,
  });

  return portalSession;
}

module.exports = {
  listActivePrices,
  createCheckoutSession,
  createBillingPortalSession,
};
