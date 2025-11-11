// routes/connectRoutes.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const db = admin.firestore();

// Create a Stripe Express account for the partner
router.post('/create-account', async (req, res) => {
  try {
    const { partnerId, email } = req.body;
    if (!partnerId || !email)
      return res.status(400).json({ error: 'partnerId and email are required' });

    const partnerRef = db.collection('partners').doc(partnerId);
    const partnerSnap = await partnerRef.get();

    // If already has an account, return it
    if (partnerSnap.exists && partnerSnap.data().stripeAccountId) {
      return res.json({
        stripeAccountId: partnerSnap.data().stripeAccountId,
        already: true,
      });
    }

    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    await partnerRef.set(
      { stripeAccountId: account.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    res.json({ stripeAccountId: account.id });
  } catch (error) {
    console.error('Error creating Connect account:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Generate URL to start Stripe onboarding
router.post('/onboard-link', async (req, res) => {
  try {
    const { partnerId } = req.body;
    if (!partnerId) return res.status(400).json({ error: 'partnerId required' });

    const partnerSnap = await db.collection('partners').doc(partnerId).get();
    if (!partnerSnap.exists)
      return res.status(404).json({ error: 'Partner not found' });

    const { stripeAccountId } = partnerSnap.data();
    if (!stripeAccountId)
      return res.status(400).json({ error: 'Partner needs a Stripe account first' });

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${process.env.CLIENT_URL}/partner/onboarding?retry=1`,
      return_url: `${process.env.CLIENT_URL}/partner/onboarding/complete`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (error) {
    console.error('Error creating onboarding link:', error);
    res.status(500).json({ error: 'Failed to create onboarding link' });
  }
});

module.exports = router;