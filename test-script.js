// test-script.js
require('dotenv').config();
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(require('./service-account-key.json')),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const db = admin.firestore();

async function testPayout() {
  try {
    // 1. Mock data - replace with actual partner ID
    const partnerId = 'partner_test123'; 
    const amount = 10.50; // Test with small amount

    // 2. Create payout record
    const payoutRef = await db.collection('payouts').add({
      partnerId,
      amount,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('Firestore: Created payout with ID:', payoutRef.id);

    // 3. Simulate Stripe transfer (test mode)
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'usd',
      destination: 'acct_123TEST', // Use test Stripe account ID
      description: 'TEST - P2P Payout'
    }, {
      idempotencyKey: `test-${Date.now()}` // Prevent duplicate transfers
    });
    console.log('Stripe: Transfer created:', transfer.id);

    // 4. Update Firestore
    await payoutRef.update({
      status: 'completed',
      stripeTransferId: transfer.id
    });
    console.log('✅ Test completed successfully!');

  } catch (err) {
    console.error('❌ Test failed:', err.message);
  } finally {
    process.exit(); // Close script
  }
}

// Run the test
testPayout();