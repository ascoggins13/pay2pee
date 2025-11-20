// services/stripeService.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { admin, firestore } = require('../firebase-admin');

const usersCol = firestore.collection('users');
const partnersCol = firestore.collection('partners');
const payoutsCol = firestore.collection('payouts');

const PLAN_PRICE_MAP = {
  weekly: process.env.STRIPE_PRICE_WEEKLY,
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_PRICE_ANNUAL,
};

function getPriceIdForPlan(planId) {
  const price = PLAN_PRICE_MAP[planId];
  if (!price) throw new Error(`Unknown planId: ${planId}`);
  return price;
}

/**
 * Create a hosted onboarding link for Stripe Connect
 */
async function createAccountOnboardingLink(accountId, returnUrl, refreshUrl) {
  return stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
}// Get the latest Stripe account object for a Connect account
async function getAccount(accountId) {
  return stripe.accounts.retrieve(accountId);
}
/**
 * Ensure Stripe customer for guest subscriptions
 */
async function ensureStripeCustomer(userId, email) {
  const ref = usersCol.doc(userId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('User not found');

  const user = snap.data();

  if (user.stripeCustomerId) {
    try {
      await stripe.customers.retrieve(user.stripeCustomerId);
      return user.stripeCustomerId;
    } catch {
      // Recreate if Stripe doesn't recognize it
    }
  }

  const customer = await stripe.customers.create({
    email,
    metadata: { userId },
  });

  await ref.set({ stripeCustomerId: customer.id }, { merge: true });

  return customer.id;
}

exports.createSubscription = async ({
  userId,
  email,
  planId,
  paymentMethodId,
}) => {
  const customerId = await ensureStripeCustomer(userId, email);

  await stripe.paymentMethods.attach(paymentMethodId, {
    customer: customerId,
  });

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  const priceId = getPriceIdForPlan(planId);

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete',
    expand: ['latest_invoice.payment_intent'],
  });

  await usersCol.doc(userId).set(
    {
      subscription: {
        id: subscription.id,
        status: subscription.status || 'incomplete',
        planId,
        priceId,
        currentPeriodEnd: subscription.current_period_end || null,
      },
    },
    { merge: true }
  );

  return { customerId, subscription };
};

/**
 * Create partner Stripe Connect account
 */
exports.createPartnerAccount = async (partnerId, email, details = {}) => {
  const account = await stripe.accounts.create({
    type: 'custom',
    country: 'US',
    email,
    business_type: 'individual',
    individual: {
      first_name: details.firstName,
      last_name: details.lastName,
      id_number: details.ssnLast4,
      dob:
        details.dobDay && details.dobMonth && details.dobYear
          ? {
              day: details.dobDay,
              month: details.dobMonth,
              year: details.dobYear,
            }
          : undefined,
    },
    capabilities: { transfers: { requested: true } },
    metadata: { partner_id: partnerId },
  });

  await partnersCol.doc(partnerId).set(
    {
      stripeAccountId: account.id,
      onboardingStatus: 'pending_verification',
    },
    { merge: true }
  );

  return account;
};

exports.getStripeDashboardLink = async (partnerId) => {
  const doc = await partnersCol.doc(partnerId).get();
  const stripeAccountId = doc.exists ? doc.data().stripeAccountId : null;

  if (!stripeAccountId)
    throw new Error('Partner has no Stripe account linked');

  const { url } = await stripe.accounts.createLoginLink(stripeAccountId);
  return url;
};

/**
 * Initiate a manual payout to partner
 */
exports.initiateManualPayout = async (partnerId, amount) => {
  if (amount < 5) throw new Error('Minimum payout amount is $5.00');

  const doc = await partnersCol.doc(partnerId).get();
  const { stripeAccountId } = doc.data() || {};

  if (!stripeAccountId)
    throw new Error('Partner has no Stripe account linked');

  const transfer = await stripe.transfers.create({
    amount: Math.round(amount * 100),
    currency: 'usd',
    destination: stripeAccountId,
    description: `P2P Partner Payout - ${new Date().toLocaleDateString()}`,
  });

  const batch = firestore.batch();

  batch.update(partnersCol.doc(partnerId), {
    pendingPayout: admin.firestore.FieldValue.increment(-amount),
    totalPayouts: admin.firestore.FieldValue.increment(amount),
    lastPayoutDate: admin.firestore.FieldValue.serverTimestamp(),
  });

  batch.set(payoutsCol.doc(), {
    partnerId,
    amount,
    stripeTransferId: transfer.id,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();

  return transfer;
};

/**
 * Record a completed booking
 */
exports.recordBooking = async (partnerId, amount) => {
  const platformFee = amount * 0.3;
  const partnerEarnings = amount * 0.7;

  await partnersCol.doc(partnerId).set(
    {
      earnings: admin.firestore.FieldValue.increment(amount),
      pendingPayout: admin.firestore.FieldValue.increment(
        partnerEarnings
      ),
      bookingsCount: admin.firestore.FieldValue.increment(1),
      platformFees: admin.firestore.FieldValue.increment(platformFee),
      lastBookingDate: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
};

/**
 * EXPORTS
 */
module.exports = {
  createSubscription: exports.createSubscription,
  createPartnerAccount: exports.createPartnerAccount,
  getStripeDashboardLink: exports.getStripeDashboardLink,
  initiateManualPayout: exports.initiateManualPayout,
  recordBooking: exports.recordBooking,
  createAccountOnboardingLink, // <-- IMPORTANT FIX
  getAccount,   // <-- NEW
};
