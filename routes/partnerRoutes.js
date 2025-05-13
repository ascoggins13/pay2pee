router.post('/onboard-partner', authMiddleware, async (req, res) => {
    try {
      const { email, partnerId } = req.body;
      
      // 1. Create Stripe Connected Account
      const account = await stripeService.createPartnerAccount(email, partnerId);
      
      // 2. Save Stripe account ID to your DB
      await PartnerModel.findByIdAndUpdate(partnerId, {
        stripeAccountId: account.id,
        onboardingStatus: 'pending_verification'
      });
  
      res.json({ 
        accountId: account.id,
        onboardingLink: account.onboarding?.url // For identity verification
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  