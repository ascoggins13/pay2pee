// routes/partnerAnalytics.js
const express = require('express');
const router = express.Router();
const { admin, firestore } = require('../firebase-admin');
const requireAuth = require('../middleware/requireAuth'); // must set req.user.partnerId

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// GET /api/partner/analytics
router.get('/analytics', requireAuth, async (req, res) => {
  try {
    const partnerId = req.user.partnerId;
    if (!partnerId) {
      return res.status(400).json({ error: 'No partnerId on user' });
    }

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    const startTs = admin.firestore.Timestamp.fromDate(startOfToday);
    const endTs = admin.firestore.Timestamp.fromDate(endOfToday);

    const guestVisitsRef = firestore.collection('guestVisits');

    // requested today
    const requestedSnap = await guestVisitsRef
      .where('partnerId', '==', partnerId)
      .where('status', '==', 'requested')
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .get();

    // active guests
    const activeSnap = await guestVisitsRef
      .where('partnerId', '==', partnerId)
      .where('status', '==', 'active')
      .get();

    const requestedGuests = requestedSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const activeGuests = activeSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Simple weekly traffic (last 7 days)
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const sevenDaysTs = admin.firestore.Timestamp.fromDate(sevenDaysAgo);

    const weeklySnap = await guestVisitsRef
      .where('partnerId', '==', partnerId)
      .where('createdAt', '>=', sevenDaysTs)
      .get();

    const trafficByDay = new Array(7).fill(0);

    weeklySnap.forEach((doc) => {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate
        ? data.createdAt.toDate()
        : new Date(data.createdAt);

      const jsDay = createdAt.getDay();     // 0=Sun..6=Sat
      const index = (jsDay + 6) % 7;        // 0=Mon..6=Sun
      trafficByDay[index] += 1;
    });

    const weeklyTraffic = trafficByDay.map((count, index) => ({
      day: DAY_LABELS[index],
      value: count,
    }));

    const stats = {
      activeGuests: activeGuests.length,
      totalGuestsToday: activeGuests.length + requestedGuests.length,
    };

    return res.json({
      stats,
      requestedGuests: requestedGuests.map((g) => ({
        id: g.id,
        name: g.userName,
        avatar: g.userAvatar || null,
      })),
      activeGuests: activeGuests.map((g) => ({
        id: g.id,
        name: g.userName,
        avatar: g.userAvatar || null,
      })),
      weeklyTraffic,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to load analytics' });
  }
});

// POST /api/partner/guests/:id/accept
router.post('/guests/:id/accept', requireAuth, async (req, res) => {
  try {
    const partnerId = req.user.partnerId;
    const visitId = req.params.id;

    const visitRef = firestore.collection('guestVisits').doc(visitId);
    const visitSnap = await visitRef.get();

    if (!visitSnap.exists) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    const visit = visitSnap.data();
    if (visit.partnerId !== partnerId) {
      return res.status(403).json({ error: 'Not authorized for this visit' });
    }

    await visitRef.update({
      status: 'active',
      startTime: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ id: visitId, status: 'active' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to accept guest' });
  }
});

module.exports = router;
