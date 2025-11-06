// controllers/stripeWebhooksController.js
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const db = admin.firestore();
const usersCol = db.collection('users');
const processedEventsCol = db.collection('stripeProcessedEvents'); // optional idempotency

async function findUserRefByStripeCustomer(customerId) {
  const snap = await usersCol.where('stripeCustomerId', '==', customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0].ref;
}

async function upsertUserSubscription(userRef, { subscription }) {
  const subItem = subscription?.items?.data?.[0];
  const priceId = subItem?.price?.id || null;
  const planId = subItem?.price?.product || null;

  await userRef.set({
    subscription: {
      id: subscription.id,
      status: subscription.status, // active | trialing | past_due | canceled | unpaid
      planId,
      priceId,
      currentPeriodEnd: subscription.current_period_end || null
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function markEventProcessed(eventId) {
  // basic idempotency guard; safe to ignore if you don’t want it
  await processedEventsCol.doc(eventId).set({
    processedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function isEventAlreadyProcessed(eventId) {
  const doc = await processedEventsCol.doc(eventId).get();
  return doc.exists;
}

exports.handleStripeEvent = async (event) => {
  // Idempotency (optional, recommended in production)
  if (await isEventAlreadyProcessed(event.id)) return;

  const type = event.type;
  const obj = event.data.object;

  switch (type) {
    //
    // 1) Checkout completed (after hosted Checkout)
    //
    case 'checkout.session.completed': {
      const session = obj; // Stripe.Checkout.Session
      const userId = session.client_reference_id; // you set this when creating the session
      const customerId = session.customer;        // cus_...
      const mode = session.mode;                  // 'subscription' or 'payment'

      // Try to find user by stripeCustomerId first
      let userRef = customerId ? await findUserRefByStripeCustomer(customerId) : null;

      // Fallback to client_reference_id (your userId) if needed
      if (!userRef && userId) {
        userRef = usersCol.doc(userId);
        // If this is the user's first purchase, store the stripeCustomerId for future events
        if (customerId) {
          await userRef.set({
            stripeCustomerId: customerId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }

      // If we still don't have a user, nothing to update
      if (!userRef) break;

      if (mode === 'subscription' && session.subscription) {
        // fetch the full subscription to get items/price/product
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        await upsertUserSubscription(userRef, { subscription });
      } else if (mode === 'payment') {
        // one-time purchase (single-use pass) – record entitlement/credit
        await userRef.set({
          lastOneTimePurchase: {
            sessionId: session.id,
            amountTotal: session.amount_total || null,
            currency: session.currency || 'usd',
            purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      break;
    }

    //
    // 2) Ongoing subscription lifecycle events (after first checkout)
    //
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = obj; // Stripe.Subscription
      const customerId = subscription.customer;
      if (!customerId) break;

      const userRef = await findUserRefByStripeCustomer(customerId);
      if (!userRef) break;

      // Normalize "deleted" to canceled status for your app
      if (type === 'customer.subscription.deleted') {
        subscription.status = 'canceled';
      }

      await upsertUserSubscription(userRef, { subscription });
      break;
    }

    default:
      // ignore other event types for now
      break;
  }

  await markEventProcessed(event.id);
};
