// routes/partnerRoutes.js
const express = require("express");
const { body, validationResult } = require("express-validator");
const axios = require("axios");

const protect = require("../middleware/protect");
const { admin, firestore } = require("../firebase-admin");
const stripeService = require("../services/stripeService");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const usersCol = firestore.collection("users");
const partnersCol = firestore.collection("partners");
const locationsCol = firestore.collection("locations");
const guestVisitsCol = firestore.collection("guestVisits");
const FieldValue = admin.firestore.FieldValue;

const GRACE_SECONDS = 180;

// ------------------------------
// Helpers
// ------------------------------
function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const d = new Date(ts);
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof ts?.toMillis === "function") return ts.toMillis();
  if (ts?._seconds) return ts._seconds * 1000;
  return null;
}

function secondsRemaining(futureTs) {
  const ms = toMillis(futureTs);
  if (!ms) return null;
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
}

async function promoteNextVisitTransactional(locationId) {
  if (!locationId) return null;

  const locRef = locationsCol.doc(locationId);

  const promoted = await firestore.runTransaction(async (tx) => {
    const locSnap = await tx.get(locRef);
    if (!locSnap.exists) return null;

    const loc = locSnap.data() || {};
    if (!loc.autoAcceptGuests) return null;

    // lock: only one active
    if (loc.currentActiveVisitId) return null;

    // ✅ grace blocks promotion (graceEndsAt)
    const graceUntilMs = toMillis(loc.graceEndsAt);
    if (graceUntilMs && graceUntilMs > Date.now()) return null;

    // if some older active exists but lock wasn't set, still avoid promoting
    const activeQ = guestVisitsCol
      .where("locationId", "==", locationId)
      .where("status", "==", "active")
      .limit(1);

    const activeSnap = await tx.get(activeQ);
    if (!activeSnap.empty) return null;

    const queuedQ = guestVisitsCol
      .where("locationId", "==", locationId)
      .where("status", "in", ["requested", "pending"])
      .orderBy("createdAt", "asc")
      .limit(1);

    const queuedSnap = await tx.get(queuedQ);
    if (queuedSnap.empty) return null;

    const doc = queuedSnap.docs[0];
    const visit = doc.data() || {};

    const now = admin.firestore.Timestamp.now();
    const maxMinutes = Number(visit.maxDurationMinutes || 8);
    const expiresAt = admin.firestore.Timestamp.fromMillis(
      now.toMillis() + maxMinutes * 60 * 1000
    );

    tx.set(
      doc.ref,
      {
        status: "active",
        startTime: now,
        expiresAt,
        accessCode: loc.accessCode || visit.accessCode || null,
        instructions: loc.instructions || visit.instructions || null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      locRef,
      {
        currentActiveVisitId: doc.id,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { id: doc.id, ...visit, status: "active", startTime: now, expiresAt };
  });

  return promoted;
}

// Helper: geocode
async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !address) return null;

  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address, key: apiKey },
    });

    if (
      !res.data ||
      res.data.status !== "OK" ||
      !Array.isArray(res.data.results) ||
      res.data.results.length === 0
    ) {
      console.warn("Geocoding failed:", res.data?.status, res.data?.error_message);
      return null;
    }

    const loc = res.data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    console.error("Geocoding error:", err);
    return null;
  }
}

// ------------------------------
// Partner router -> /api/partner/*
// ------------------------------
const partnerRouter = express.Router();

/**
 * GET /api/partner/summary
 */
partnerRouter.get("/summary", protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    const [userDoc, partnerDoc, locSnap] = await Promise.all([
      usersCol.doc(userId).get(),
      partnersCol.doc(userId).get(),
      locationsCol.where("owner", "==", userId).limit(1).get(),
    ]);

    const user = userDoc.exists ? userDoc.data() : {};
    const partner = partnerDoc.exists ? partnerDoc.data() : {};

    const hasLocation = !locSnap.empty;
    const locDoc = hasLocation ? locSnap.docs[0] : null;
    const loc = hasLocation ? locDoc.data() : {};
    const locId = hasLocation ? locDoc.id : null;

    // Refresh Stripe status live
    let stripeStatus = partner.stripeStatus || {};
    if (
      partner.stripeAccountId &&
      stripeService &&
      typeof stripeService.getAccount === "function"
    ) {
      try {
        const acct = await stripeService.getAccount(partner.stripeAccountId);
        stripeStatus = {
          charges_enabled: !!acct.charges_enabled,
          payouts_enabled: !!acct.payouts_enabled,
          details_submitted: !!acct.details_submitted,
        };

        await partnersCol.doc(userId).set(
          {
            stripeStatus,
            onboardingStatus: acct.details_submitted ? "verified" : "pending_verification",
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      } catch (err) {
        console.error("Error refreshing Stripe account status:", err);
        stripeStatus = partner.stripeStatus || {};
      }
    }

    // Stripe balance
    let stripeBalanceTotal = null;
    let stripeAvailable = null;
    let stripePending = null;

    if (partner.stripeAccountId && process.env.STRIPE_SECRET_KEY) {
      try {
        const bal = await stripe.balance.retrieve({
          stripeAccount: partner.stripeAccountId,
        });

        const avail = Array.isArray(bal.available) ? bal.available[0] : null;
        const pend = Array.isArray(bal.pending) ? bal.pending[0] : null;

        stripeAvailable = avail ? avail.amount / 100 : 0;
        stripePending = pend ? pend.amount / 100 : 0;
        stripeBalanceTotal = (stripeAvailable || 0) + (stripePending || 0);
      } catch (err) {
        console.error("Error fetching Stripe balance in /partner/summary:", err);
      }
    }

    const totalBalance =
      stripeBalanceTotal !== null ? stripeBalanceTotal : Number(partner.pendingPayout || 0);

    const availableBalance = stripeAvailable !== null ? stripeAvailable : totalBalance;
    const pendingBalance = stripePending !== null ? stripePending : null;

    // Today visits count (all visits created today for this location)
    let todayCount = 0;
    if (locId) {
      try {
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);

        const startTs = admin.firestore.Timestamp.fromDate(start);
        const endTs = admin.firestore.Timestamp.fromDate(end);

        const visitsSnap = await guestVisitsCol
          .where("locationId", "==", locId)
          .where("createdAt", ">=", startTs)
          .where("createdAt", "<=", endTs)
          .get();

        todayCount = visitsSnap.size || 0;
      } catch (err) {
        console.error("Error computing todayVisits in /partner/summary:", err);
      }
    }

    return res.json({
      partnerId: userId,
      email: user.email || partner.email || null,

      name: loc.name || partner.businessName || "Your Bathroom Name",
      address: loc.address || partner.businessAddress || "Add your address so guests can find you.",
      isActive: loc.isActive !== false,

      todayVisits: todayCount,

      currentBalance: totalBalance,
      availableBalance,
      pendingBalance,
      stripeBalance: totalBalance,
      stripeAvailableBalance: availableBalance,
      stripePendingBalance: pendingBalance,

      lastPayoutDate: partner.lastPayoutDate || null,
      rating: loc.rating || 4.8,

      reviews: Array.isArray(loc.recentReviews) ? loc.recentReviews : [],
      activeGuests: Array.isArray(loc.activeGuests) ? loc.activeGuests : [],

      locationDetails: {
        price: Number(loc.price || loc.pricing?.basePrice || 0),
        accessCode: loc.accessCode || "",
        hours: loc.hours || "—",
        description: loc.description || "",
        features: Array.isArray(loc.amenities) ? loc.amenities : [],
        photos: Array.isArray(loc.photos) ? loc.photos : [],
      },

      ownerName:
        partner.ownerName || user.name || (user.email ? user.email.split("@")[0] : "Partner"),
      avatarUrl: partner.avatarUrl || user.avatarUrl || "",

      stripeAccountId: partner.stripeAccountId || null,
      stripeStatus: {
        charges_enabled: !!stripeStatus.charges_enabled,
        payouts_enabled: !!stripeStatus.payouts_enabled,
        details_submitted: !!stripeStatus.details_submitted,
      },
    });
  } catch (err) {
    console.error("GET /partner/summary error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/partner/analytics
 */
partnerRouter.get("/analytics", protect, async (req, res) => {
  try {
    const partnerId = req.user.userId || req.user.id;
    if (!partnerId) return res.status(400).json({ error: "Missing partner id" });

    const locSnap = await locationsCol.where("owner", "==", partnerId).limit(1).get();
    if (locSnap.empty) {
      return res.json({
        stats: { activeGuests: 0, totalGuestsToday: 0 },
        requestedGuests: [],
        activeGuests: [],
        weeklyTraffic: [
          { day: "Monday", value: 0 },
          { day: "Tuesday", value: 0 },
          { day: "Wednesday", value: 0 },
          { day: "Thursday", value: 0 },
          { day: "Friday", value: 0 },
          { day: "Saturday", value: 0 },
          { day: "Sunday", value: 0 },
        ],
        autoAcceptGuests: true,
        graceSecondsRemaining: null,
        locationId: null,
      });
    }

    const locDoc = locSnap.docs[0];
    const locationId = locDoc.id;
    const locData = locDoc.data() || {};

    const autoAcceptGuests =
      typeof locData.autoAcceptGuests === "boolean" ? locData.autoAcceptGuests : true;

    let graceSecondsRemaining = locData.graceEndsAt ? secondsRemaining(locData.graceEndsAt) : null;

    // If grace ended and auto-accept ON, promote next
    if (autoAcceptGuests) {
      const graceUntilMs = toMillis(locData.graceEndsAt);
      const graceActive = graceUntilMs && graceUntilMs > Date.now();
      if (!graceActive) {
        await promoteNextVisitTransactional(locationId);
        const freshLoc = await locationsCol.doc(locationId).get();
        const fresh = freshLoc.exists ? freshLoc.data() : {};
        graceSecondsRemaining = fresh?.graceEndsAt ? secondsRemaining(fresh.graceEndsAt) : null;
      }
    }

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    const startTs = admin.firestore.Timestamp.fromDate(startOfToday);
    const endTs = admin.firestore.Timestamp.fromDate(endOfToday);

    const requestedSnap = await guestVisitsCol
      .where("locationId", "==", locationId)
      .where("status", "in", ["requested", "pending"])
      .where("createdAt", ">=", startTs)
      .where("createdAt", "<=", endTs)
      .orderBy("createdAt", "asc")
      .get();

    const activeSnap = await guestVisitsCol
      .where("locationId", "==", locationId)
      .where("status", "==", "active")
      .get();

    const requestedGuests = requestedSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const activeGuests = activeSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const todayAllSnap = await guestVisitsCol
      .where("locationId", "==", locationId)
      .where("createdAt", ">=", startTs)
      .where("createdAt", "<=", endTs)
      .get();

    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const sevenDaysTs = admin.firestore.Timestamp.fromDate(sevenDaysAgo);

    const weeklySnap = await guestVisitsCol
      .where("locationId", "==", locationId)
      .where("createdAt", ">=", sevenDaysTs)
      .get();

    const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const trafficByDay = new Array(7).fill(0);

    weeklySnap.forEach((doc) => {
      const data = doc.data();
      const raw = data.createdAt;
      if (!raw || typeof raw.toDate !== "function") return;
      const createdAt = raw.toDate();
      const jsDay = createdAt.getDay(); // 0=Sun..6=Sat
      const index = (jsDay + 6) % 7; // 0=Mon..6=Sun
      trafficByDay[index] += 1;
    });

    const weeklyTraffic = trafficByDay.map((count, index) => ({
      day: DAY_LABELS[index],
      value: count,
    }));

    return res.json({
      stats: {
        activeGuests: activeGuests.length,
        totalGuestsToday: todayAllSnap.size,
      },
      requestedGuests,
      activeGuests,
      weeklyTraffic,
      autoAcceptGuests,
      graceSecondsRemaining,
      locationId,
    });
  } catch (err) {
    console.error("GET /partner/analytics error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/partner/guests/:visitId/accept
 */
partnerRouter.post("/guests/:visitId/accept", protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { visitId } = req.params;

    const visitRef = guestVisitsCol.doc(visitId);

    await firestore.runTransaction(async (tx) => {
      const visitSnap = await tx.get(visitRef);
      if (!visitSnap.exists) throw new Error("VISIT_NOT_FOUND");

      const visit = visitSnap.data() || {};
      const locationId = visit.locationId;
      if (!locationId) throw new Error("VISIT_NO_LOCATION");

      const locRef = locationsCol.doc(locationId);
      const locSnap = await tx.get(locRef);
      if (!locSnap.exists) throw new Error("LOCATION_NOT_FOUND");

      const loc = locSnap.data() || {};
      if (loc.owner !== userId) throw new Error("NOT_ALLOWED");

      if (!["requested", "pending"].includes(visit.status)) throw new Error("NOT_PENDING");

      const graceUntilMs = toMillis(loc.graceEndsAt);
      if (graceUntilMs && Date.now() < graceUntilMs) throw new Error("IN_GRACE");

      if (loc.currentActiveVisitId) throw new Error("ALREADY_ACTIVE");

      const nowTs = admin.firestore.Timestamp.now();
      const maxDurationMinutes = Number(visit.maxDurationMinutes || 8);
      const expiresAt = admin.firestore.Timestamp.fromMillis(
        nowTs.toMillis() + maxDurationMinutes * 60 * 1000
      );

      tx.set(
        visitRef,
        {
          status: "active",
          startTime: nowTs,
          expiresAt,
          accessCode: loc.accessCode || visit.accessCode || null,
          instructions: loc.instructions || visit.instructions || null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(
        locRef,
        { currentActiveVisitId: visitId, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    });

    return res.json({ id: visitId, status: "active" });
  } catch (err) {
    const msg = err?.message || "";
    if (msg === "VISIT_NOT_FOUND") return res.status(404).json({ error: "Visit not found" });
    if (msg === "LOCATION_NOT_FOUND") return res.status(404).json({ error: "Location not found" });
    if (msg === "NOT_ALLOWED") return res.status(403).json({ error: "Not allowed" });
    if (msg === "NOT_PENDING") return res.status(400).json({ error: "Visit is not pending" });
    if (msg === "IN_GRACE") return res.status(409).json({ error: "Location is in grace period" });
    if (msg === "ALREADY_ACTIVE")
      return res.status(409).json({ error: "A guest is already active for this location" });

    console.error("POST /partner/guests/:visitId/accept error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/partner/guests/:visitId/end
 * ✅ writes graceEndsAt
 */
partnerRouter.post("/guests/:visitId/end", protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { visitId } = req.params;

    const visitRef = guestVisitsCol.doc(visitId);

    const result = await firestore.runTransaction(async (tx) => {
      const visitSnap = await tx.get(visitRef);
      if (!visitSnap.exists) throw new Error("VISIT_NOT_FOUND");

      const visit = visitSnap.data() || {};
      const locationId = visit.locationId;
      if (!locationId) throw new Error("VISIT_NO_LOCATION");

      const locRef = locationsCol.doc(locationId);
      const locSnap = await tx.get(locRef);
      if (!locSnap.exists) throw new Error("LOCATION_NOT_FOUND");

      const loc = locSnap.data() || {};
      if (loc.owner !== userId) throw new Error("NOT_ALLOWED");
      if (visit.status !== "active") throw new Error("NOT_ACTIVE");

      const nowTs = admin.firestore.Timestamp.now();
      const graceEndsAt = admin.firestore.Timestamp.fromMillis(
        nowTs.toMillis() + GRACE_SECONDS * 1000
      );

      tx.set(
        visitRef,
        {
          status: "completed",
          endTime: nowTs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const updates = { graceEndsAt, updatedAt: FieldValue.serverTimestamp() };
      if (loc.currentActiveVisitId === visitId) updates.currentActiveVisitId = null;

      tx.set(locRef, updates, { merge: true });

      return { graceSecondsRemaining: GRACE_SECONDS };
    });

    return res.json({
      id: visitId,
      status: "completed",
      graceSecondsRemaining: result.graceSecondsRemaining,
    });
  } catch (err) {
    const msg = err?.message || "";
    if (msg === "VISIT_NOT_FOUND") return res.status(404).json({ error: "Visit not found" });
    if (msg === "LOCATION_NOT_FOUND") return res.status(404).json({ error: "Location not found" });
    if (msg === "NOT_ALLOWED") return res.status(403).json({ error: "Not allowed" });
    if (msg === "NOT_ACTIVE") return res.status(400).json({ error: "Visit is not currently active" });

    console.error("POST /partner/guests/:visitId/end error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /api/partner/location
 */
partnerRouter.put(
  "/location",
  protect,
  [
    body("name").optional().isString(),
    body("address").optional().isString(),
    body("accessCode").optional().isString(),
    body("price").optional().isFloat({ min: 0 }),
    body("description").optional().isString(),
    body("features").optional().isArray(),
    body("photos").optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId || req.user.id;
      const { name, address, accessCode, price = 0, description = "", features = [], photos = [] } =
        req.body;

      const snap = await locationsCol.where("owner", "==", userId).limit(1).get();

      let locRef;
      let existing = {};
      if (snap.empty) {
        locRef = locationsCol.doc();
      } else {
        locRef = snap.docs[0].ref;
        existing = snap.docs[0].data() || {};
      }

      const addressChanged =
        typeof address === "string" &&
        address.trim() &&
        address.trim() !== (existing.address || "").trim();

      let coordinates = existing.coordinates || null;

      if (addressChanged || !coordinates) {
        const geo = await geocodeAddress(address || existing.address);
        if (geo) coordinates = geo;
      }

      const update = {
        owner: userId,
        name: name !== undefined ? name : existing.name,
        address: address !== undefined ? address : existing.address,
        accessCode: accessCode !== undefined ? accessCode : existing.accessCode || "",
        price: Number(price),
        description,
        amenities: Array.isArray(features) ? features : [],
        photos: Array.isArray(photos) ? photos : [],
        coordinates: coordinates || existing.coordinates || null,
        isActive: existing.isActive !== undefined ? existing.isActive : true,
        updatedAt: FieldValue.serverTimestamp(),
      };

      await locRef.set(update, { merge: true });
      const updatedSnap = await locRef.get();
      const loc = updatedSnap.data() || {};

      return res.json({ id: locRef.id, location: loc });
    } catch (err) {
      console.error("PUT /partner/location error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * POST /api/partner/onboard-link
 */
partnerRouter.post("/onboard-link", protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    let email = req.body.email;
    if (!email) {
      const userDoc = await usersCol.doc(userId).get();
      email = userDoc.exists ? userDoc.data().email : null;
    }
    if (!email) return res.status(400).json({ error: "Email required" });

    const partnerRef = partnersCol.doc(userId);
    const partnerSnap = await partnerRef.get();
    const partnerData = partnerSnap.exists ? partnerSnap.data() : {};
    let { stripeAccountId } = partnerData;

    if (!stripeAccountId) {
      const account = await stripeService.createPartnerAccount(userId, email, req.body || {});
      stripeAccountId = account.id;
      await partnerRef.set(
        { stripeAccountId, onboardingStatus: "pending_verification" },
        { merge: true }
      );
    }

    const FRONTEND_URL = process.env.FRONTEND_URL || "https://pay2pee.app";
    const returnUrl = `${FRONTEND_URL}/partner`;
    const refreshUrl = `${FRONTEND_URL}/partner`;

    const link = await stripeService.createAccountOnboardingLink(
      stripeAccountId,
      returnUrl,
      refreshUrl
    );

    return res.json({ url: link.url, frontendUrl: FRONTEND_URL });
  } catch (err) {
    console.error("POST /partner/onboard-link error:", err);
    return res.status(500).json({ error: err.message || "Stripe onboarding link error" });
  }
});

// ------------------------------
// Host router -> /api/host/*
// ------------------------------
const hostRouter = express.Router();

/**
 * PUT /api/host/visibility
 */
hostRouter.put(
  "/visibility",
  protect,
  [body("isActive").isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId || req.user.id;
      const { isActive } = req.body;

      const snap = await locationsCol.where("owner", "==", userId).limit(1).get();
      if (snap.empty) return res.status(404).json({ error: "Location not found" });

      const locRef = snap.docs[0].ref;
      await locRef.set({ isActive, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      return res.json({ success: true, isActive });
    } catch (err) {
      console.error("PUT /host/visibility error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * PUT /api/host/auto-accept
 */
hostRouter.put(
  "/auto-accept",
  protect,
  [body("autoAcceptGuests").isBoolean().withMessage("autoAcceptGuests must be true or false")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId || req.user.id;
      const { locationId, autoAcceptGuests } = req.body;

      let ref;

      if (locationId) {
        ref = locationsCol.doc(locationId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "Location not found" });

        const loc = snap.data() || {};
        if (loc.owner !== userId) {
          return res.status(403).json({ error: "You are not allowed to update this location" });
        }
      } else {
        const snap = await locationsCol.where("owner", "==", userId).limit(1).get();
        if (snap.empty) return res.status(404).json({ error: "Location not found" });
        ref = snap.docs[0].ref;
      }

      await ref.set({ autoAcceptGuests, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      const updated = await ref.get();
      const updatedLoc = updated.data() || {};
      return res.json({ id: ref.id, autoAcceptGuests: !!updatedLoc.autoAcceptGuests });
    } catch (err) {
      console.error("PUT /host/auto-accept error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * POST /api/host/payout
 */
hostRouter.post(
  "/payout",
  protect,
  [body("amountRequested").isFloat({ min: 5 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const partnerId = req.user.userId || req.user.id;
      const amount = Number(req.body.amountRequested);

      const transfer = await stripeService.initiateManualPayout(partnerId, amount);

      const doc = await partnersCol.doc(partnerId).get();
      const pdata = doc.exists ? doc.data() : {};

      return res.json({
        success: true,
        transferId: transfer.id,
        newBalance: Number(pdata.pendingPayout || 0),
        lastPayoutDate: pdata.lastPayoutDate || new Date().toISOString(),
      });
    } catch (err) {
      console.error("POST /host/payout error:", err);
      return res.status(500).json({ error: err.message || "Stripe error" });
    }
  }
);


module.exports = { partnerRouter, hostRouter };