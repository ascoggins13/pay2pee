const express = require("express");
const protect = require("../middleware/protect");
const admin = require("firebase-admin");

const router = express.Router();
const db = admin.firestore();

const referrersCol = db.collection("referrers");
const locationReferralsCol = db.collection("locationReferrals");
const paymentEarningsCol = db.collection("paymentEarnings");
const referralPayoutsCol = db.collection("referralPayouts");

// Replace with your real admin middleware if you have one
const adminOnly = protect;

function centsToNumber(cents) {
  return Number(cents || 0);
}

router.get("/overview", adminOnly, async (req, res) => {
  try {
    const [
      referrersSnap,
      locationReferralsSnap,
      paymentEarningsSnap,
      payoutsSnap,
    ] = await Promise.all([
      referrersCol.get(),
      locationReferralsCol.get(),
      paymentEarningsCol.get(),
      referralPayoutsCol.get().catch(() => ({ docs: [] })),
    ]);

    const referrers = referrersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const locations = locationReferralsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const earnings = paymentEarningsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const payouts = payoutsSnap.docs ? payoutsSnap.docs.map((d) => ({ id: d.id, ...d.data() })) : [];

    const totalReferrers = referrers.length;
    const activeReferrers = referrers.filter((r) => ["approved", "active"].includes(r.status)).length;
    const approvedLocations = locations.length;
    const earningLocations = locations.filter((l) => l.status === "earning").length;

    const totalGrossRevenue = earnings.reduce((sum, e) => sum + centsToNumber(e.grossAmount), 0);
    const totalPlatformEarnings = earnings.reduce((sum, e) => sum + centsToNumber(e.platformFeeAmount), 0);
    const totalReferralCommission = earnings.reduce((sum, e) => sum + centsToNumber(e.referralCommissionAmount), 0);
    const unpaidReferralCommission = earnings
      .filter((e) => e.payoutStatus === "unpaid")
      .reduce((sum, e) => sum + centsToNumber(e.referralCommissionAmount), 0);

    const totalPaidOut = payouts
      .filter((p) => p.status === "paid")
      .reduce((sum, p) => sum + centsToNumber(p.totalCommissionAmount), 0);

    const recentActivity = earnings
      .sort((a, b) => {
        const aMs = a.paidAt?.toMillis ? a.paidAt.toMillis() : 0;
        const bMs = b.paidAt?.toMillis ? b.paidAt.toMillis() : 0;
        return bMs - aMs;
      })
      .slice(0, 10)
      .map((e) => ({
        id: e.id,
        locationId: e.locationId || null,
        referrerId: e.referrerId || null,
        grossAmount: e.grossAmount || 0,
        platformFeeAmount: e.platformFeeAmount || 0,
        referralCommissionAmount: e.referralCommissionAmount || 0,
        payoutStatus: e.payoutStatus || "unknown",
        paidAt: e.paidAt || null,
      }));

    return res.json({
      kpis: {
        totalReferrers,
        activeReferrers,
        approvedLocations,
        earningLocations,
        totalGrossRevenue,
        totalPlatformEarnings,
        totalReferralCommission,
        unpaidReferralCommission,
        totalPaidOut,
      },
      recentActivity,
    });
  } catch (err) {
    console.error("GET /overview error:", err);
    return res.status(500).json({ error: err.message || "Failed to load overview" });
  }
});

router.get("/referrers", adminOnly, async (req, res) => {
  try {
    const snap = await referrersCol.get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ referrers: rows });
  } catch (err) {
    console.error("GET /referrers error:", err);
    return res.status(500).json({ error: err.message || "Failed to load referrers" });
  }
});

router.get("/locations", adminOnly, async (req, res) => {
  try {
    const snap = await locationReferralsCol.get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ locations: rows });
  } catch (err) {
    console.error("GET /locations error:", err);
    return res.status(500).json({ error: err.message || "Failed to load locations" });
  }
});

router.get("/earnings", adminOnly, async (req, res) => {
  try {
    const snap = await paymentEarningsCol
      .orderBy("paidAt", "desc")
      .limit(100)
      .get();

    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ earnings: rows });
  } catch (err) {
    console.error("GET /earnings error:", err);
    return res.status(500).json({ error: err.message || "Failed to load earnings" });
  }
});

module.exports = router;