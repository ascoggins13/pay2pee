// routes/connectRoutes.js
const express = require('express');
const { admin, firestore } = require('../firebase-admin');
const protect = require('../middleware/protect');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const router = express.Router();
const usersCol = firestore.collection('users');
const partnersCol = firestore.collection('partners');

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

/**
 * Helper: get or create a Stripe Connect account for this partner.
 */
async function getOrCreateConnectAccount(userId, emailHint) {
  // 1. Look in partners collection first
  const partnerRef = partnersCol.doc(userId);
  const partnerSnap = await partnerRef.get();
  const partnerData = partnerSnap.exists ? partnerSnap.data() : {};

  if (partnerData.stripeAccountId) {
    return partnerData.stripeAccountId;
  }

  // 2. Resolve email: prefer explicit, then users collection
  let email = emailHint;
  if (!email) {
    const userSnap = await usersCol.doc(userId).get();
    if (userSnap.exists && userSnap.data().email) {
      email = userSnap.data().email;
    }
  }
  if (!email) {
    throw new Error('Email required to create Stripe account');
  }

  // 3. Create Connect account (Express)
  const account = await stripe.accounts.create({
    type: 'express',
    email,
    business_type: 'individual',
    metadata: { userId },
  });

  // 4. Persist on partners/{userId}
  await partnerRef.set(
    {
      stripeAccountId: account.id,
      onboardingStatus: 'pending_verification',
    },
    { merge: true }
  );

  return account.id;
}

/**
 * POST /api/connect/create-account
 * Body: { partnerId?, email? }
 * Returns: { stripeAccountId }
 *
 * This is used by ensureConnectAccount() in PartnerHomeScreen.
 */
router.post('/create-account', protect, async (req, res) => {
  try {
    const partnerId = req.body.partnerId || req.user.userId;
    if (!partnerId) {
      return res.status(400).json({ error: 'Missing partnerId/userId' });
    }

    const email = req.body.email || null;
    const accountId = await getOrCreateConnectAccount(partnerId, email);

    return res.json({ stripeAccountId: accountId });
  } catch (err) {
    console.error('POST /connect/create-account error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to create Stripe account' });
  }
});

/**
 * POST /api/connect/onboard-link
 * Body: { partnerId? }
 * Returns: { url }
 *
 * This is used by startOnboarding() in PartnerHomeScreen.
 */
router.post('/onboard-link', protect, async (req, res) => {
  try {
    const partnerId = req.body.partnerId || req.user.userId;
    if (!partnerId) {
      return res.status(400).json({ error: 'Missing partnerId/userId' });
    }

    // Make sure an account exists (or create one)
    const partnerRef = partnersCol.doc(partnerId);
    const partnerSnap = await partnerRef.get();
    const partnerData = partnerSnap.exists ? partnerSnap.data() : {};

    let accountId = partnerData.stripeAccountId;

    if (!accountId) {
      // fallback create – same logic as create-account, but without emailHint
      accountId = await getOrCreateConnectAccount(partnerId, null);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${CLIENT_URL}/#/partner`,
      return_url: `${CLIENT_URL}/#/partner`,
      type: 'account_onboarding',
    });

    return res.json({ url: accountLink.url });
  } catch (err) {
    console.error('POST /connect/onboard-link error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to create onboarding link' });
  }
});

module.exports = router;
