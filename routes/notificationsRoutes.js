// routes/notificationsRoutes.js
const express = require('express');
const { admin, firestore } = require('../firebase-admin');
const protect = require('../middleware/protect');

const router = express.Router();
const notificationsCol = firestore.collection('notifications');

// GET /notifications - get current user's notifications (latest first)
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    const snap = await notificationsCol
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();

    const notifications = [];
    snap.forEach(doc => {
      notifications.push({ id: doc.id, ...doc.data() });
    });

    return res.json({ notifications });
  } catch (err) {
    console.error('GET /notifications error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /notifications/mark-read - body: { ids: [id1, id2, ...] }
router.post('/mark-read', protect, async (req, res) => {
  try {
    const userId = req.user.userId;
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];

    if (!ids.length) {
      return res.json({ success: true });
    }

    const batch = firestore.batch();

    for (const id of ids) {
      const ref = notificationsCol.doc(id);
      batch.update(ref, {
        read: true,
        readAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
    return res.json({ success: true });
  } catch (err) {
    console.error('POST /notifications/mark-read error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
