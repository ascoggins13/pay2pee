// routes/connectRoutes.js
const express = require('express');
const { protect } = require('../middleware/auth'); // or your protect
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const db = admin.firestore();
const router = express.Router();

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

/**
 * POST /api/connect/onboard-link
 * Body: { partnerId, email }
 * Returns: { url }
 */
router.post('/onboard-link', protect, async (req, res) => {
  try {
    const { partnerId, email } = req.body;

    // You can also trust req.user.userId instead of partnerId, if you prefer
    const userId = partnerId || req.user.userId;
    if (!userId) {
      return res.status(400).json({ error: 'Missing partnerId/userId' });
    }

    // Load partner user from Firestore (adjust collection name if different)
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Partner user not found' });
    }

    const user = userSnap.data();

    // 1. Reuse existing Stripe account if available
    let accountId = user.stripeAccountId;

    // 2. If no account yet, create one
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email || user.email,
        business_type: 'individual',
        metadata: {
          userId,
        },
      });

      accountId = account.id;

      // Save account id back to Firestore
      await userRef.set({ stripeAccountId: accountId }, { merge: true });
    }

    // 3. Create an onboarding link for this account
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${CLIENT_URL}/#/partner`, // where to send them if they abandon/refresh
      return_url: `${CLIENT_URL}/#/partner`,  // where to send after completing onboarding
      type: 'account_onboarding',
    });

    return res.json({ url: accountLink.url });
  } catch (err) {
    console.error('Stripe onboarding link error:', err);
    return res.status(500).json({ error: 'Failed to create onboarding link' });
  }
});

module.exports = router;
