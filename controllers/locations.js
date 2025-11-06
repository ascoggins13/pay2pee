// controllers/locations.js (Firestore version)
const admin = require('firebase-admin');

const db = admin.firestore();
const ratingsCol = db.collection('ratings');
const locationsCol = db.collection('locations');

// Assumes req.user = { userId } has been set by your protect middleware
exports.submitRating = async (req, res) => {
  try {
    const { locationId, rating, comment } = req.body;
    if (!locationId || !rating) {
      return res.status(400).json({ success: false, error: 'Missing locationId or rating' });
    }

    // 1) Create rating document
    const ratingDoc = {
      userId: req.user.userId,
      locationId,
      rating: Number(rating),
      comment: comment || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await ratingsCol.add(ratingDoc);

    // 2) Recompute average & count (simple approach)
    const snap = await ratingsCol.where('locationId', '==', locationId).get();
    const { total, count } = snap.docs.reduce(
      (acc, d) => ({ total: acc.total + (d.data().rating || 0), count: acc.count + 1 }),
      { total: 0, count: 0 }
    );
    const avg = count ? total / count : 0;

    await locationsCol.doc(locationId).set(
      { rating: { average: avg, count } },
      { merge: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('submitRating error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
