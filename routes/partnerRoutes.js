const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const stripeService = require('../services/stripeService');
const PartnerModel = require('../models/Partner');

/**
 * @route POST /api/partners/onboard-partner
 * @desc Onboard a new partner with Stripe Connect
 * @access Private
 * @body {email: string, partnerId: string}
 * @returns {accountId: string, onboardingLink: string}
 */
router.post('/onboard-partner', protect, async (req, res) => {
  try {
    const { email, partnerId } = req.body;
    
    // Input validation
    if (!email || !partnerId) {
      return res.status(400).json({ error: 'Email and partnerId are required' });
    }

    // 1. Create Stripe Connected Account
    const account = await stripeService.createPartnerAccount(email, partnerId);
    
    // 2. Save Stripe account ID to database
    const updatedPartner = await PartnerModel.findByIdAndUpdate(
      partnerId,
      {
        stripeAccountId: account.id,
        onboardingStatus: 'pending_verification'
      },
      { new: true }
    );

    if (!updatedPartner) {
      return res.status(404).json({ error: 'Partner not found' });
    }

    res.json({ 
      success: true,
      accountId: account.id,
      onboardingLink: account.onboarding?.url // For identity verification
    });
  } catch (err) {
    console.error('Partner onboarding error:', err);
    res.status(500).json({ 
      success: false,
      error: err.message || 'Partner onboarding failed' 
    });
  }
});

module.exports = router;