const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

/**********************
 * Subscription Logic *
 **********************/
exports.createSubscription = async ({ userId, email, planId, paymentMethodId }) => {
  // (Keep your existing subscription code)
  return { customerId: customer.id, subscription };
};

exports.getPriceIdForPlan = (planId) => {
  // (Keep your existing plan mapping)
  return plans[planId];
};

/*********************
 * Partner Payouts *
 *********************/
/**
 * Creates a Connected Account for bathroom hosts
 * @param {string} email - Partner's email
 * @param {string} partnerId - Your internal partner ID
 * @param {Object} details - KYC details {first_name, last_name, dob, ssn_last_4, etc.}
 */
exports.createPartnerAccount = async (email, partnerId, details) => {
  const account = await stripe.accounts.create({
    type: 'custom',
    country: 'US', // Adjust based on partner location
    email,
    business_type: 'individual',
    individual: {
      first_name: details.firstName,
      last_name: details.lastName,
      id_number: details.ssnLast4, // For US
      dob: {
        day: details.dobDay,
        month: details.dobMonth,
        year: details.dobYear,
      },
    },
    capabilities: {
      transfers: { requested: true },
    },
    metadata: { partner_id: partnerId },
  });

  // Save to Firestore
  await admin.firestore().collection('partners').doc(partnerId).set({
    stripeAccountId: account.id,
    onboardingStatus: 'pending_verification',
  }, { merge: true });

  return account;
};

/**
 * Generates login link for partners to access their Stripe dashboard
 * @param {string} partnerId - Your internal partner ID
 */
exports.getStripeDashboardLink = async (partnerId) => {
  const partnerDoc = await admin.firestore().collection('partners').doc(partnerId).get();
  const stripeAccountId = partnerDoc.data().stripeAccountId;

  if (!stripeAccountId) {
    throw new Error('Partner has no Stripe account linked');
  }

  const { url } = await stripe.accounts.createLoginLink(stripeAccountId);
  return url;
};

/**
 * Processes manual payout to partner's bank account
 * @param {string} partnerId - Your internal partner ID
 * @param {number} amount - Amount in dollars (e.g. 50.00)
 */
exports.initiateManualPayout = async (partnerId, amount) => {
  const partnerDoc = await admin.firestore().collection('partners').doc(partnerId).get();
  const { stripeAccountId } = partnerDoc.data();

  // Validate minimum payout amount
  if (amount < 5.00) { // $5 minimum
    throw new Error('Minimum payout amount is $5.00');
  }

  // Create transfer
  const transfer = await stripe.transfers.create({
    amount: Math.round(amount * 100), // Convert to cents
    currency: 'usd',
    destination: stripeAccountId,
    description: `P2P Partner Payout - ${new Date().toLocaleDateString()}`,
  });

  // Update Firestore
  const batch = admin.firestore().batch();
  const partnerRef = admin.firestore().collection('partners').doc(partnerId);
  const payoutRef = admin.firestore().collection('payouts').doc();

  batch.update(partnerRef, {
    pendingPayout: admin.firestore.FieldValue.increment(-amount),
    totalPayouts: admin.firestore.FieldValue.increment(amount),
  });

  batch.set(payoutRef, {
    partnerId,
    amount,
    stripeTransferId: transfer.id,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();

  return transfer;
};

/********************
 * Earnings Tracking *
 ********************/
/**
 * Records a new booking and updates partner earnings
 * @param {string} partnerId - Your internal partner ID
 * @param {number} amount - Booking amount in dollars (e.g. 3.99)
 */
exports.recordBooking = async (partnerId, amount) => {
  const partnerRef = admin.firestore().collection('partners').doc(partnerId);
  const platformFee = amount * 0.3; // 30% platform cut
  const partnerEarnings = amount * 0.7; // 70% to partner

  await partnerRef.update({
    earnings: admin.firestore.FieldValue.increment(amount),
    pendingPayout: admin.firestore.FieldValue.increment(partnerEarnings),
    bookingsCount: admin.firestore.FieldValue.increment(1),
    platformFees: admin.firestore.FieldValue.increment(platformFee),
    lastBookingDate: admin.firestore.FieldValue.serverTimestamp(),
  });
};
