// routes/paymentsRoutes.js
const express = require("express");
const { body, validationResult } = require("express-validator");
const protect = require("../middleware/protect");
const payments = require("../controllers/paymentsController");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { firestore, admin } = require("../firebase-admin");
const { createNotification } = require("../services/notificationService");

const router = express.Router();

const guestVisitsCol = firestore.collection("guestVisits");
const locationsCol = firestore.collection("locations");

// ------------------------------
// Queue + Grace Period Helpers
// ------------------------------
// 3 minute cleanup window between guests
const GRACE_SECONDS = 180;

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  if (typeof ts?.toMillis === "function") return ts.toMillis();
  if (ts?._seconds) return ts._seconds * 1000;
  return null;
}

async function computeGrace(locationId) {
  if (!locationId) return { graceUntil: null, graceSecondsRemaining: null };
  const locSnap = await locationsCol.doc(locationId).get();
  if (!locSnap.exists) return { graceUntil: null, graceSecondsRemaining: null };

  const graceUntil = locSnap.data()?.graceUntil || null;
  const graceUntilMs = toMillis(graceUntil);
  if (!graceUntilMs) return { graceUntil: null, graceSecondsRemaining: null };

  const remaining = Math.max(0, Math.ceil((graceUntilMs - Date.now()) / 1000));
  return { graceUntil, graceSecondsRemaining: remaining };
}

async function setGraceWindow(locationId) {
  if (!locationId) return null;
  const graceUntil = admin.firestore.Timestamp.fromMillis(
    Date.now() + GRACE_SECONDS * 1000
  );
  await locationsCol.doc(locationId).set({ graceUntil }, { merge: true });
  return graceUntil;
}

async function hasActiveVisit(locationId) {
  const snap = await guestVisitsCol
    .where("locationId", "==", locationId)
    .where("status", "==", "active")
    .limit(1)
    .get();
  return !snap.empty;
}

// NOTE: paymentsRoutes should NOT “force-promote” during grace.
// Partner side (partnerRoutes /analytics) is already responsible for promotion when grace ends.
// This helper is kept for rare cases where you want session endpoint to opportunistically activate,
// but we will only use it when auto-accept is ON, grace is NOT active, and no active visit exists.
async function maybePromoteNextQueued(locationId) {
  if (!locationId) return null;

  const locSnap = await locationsCol.doc(locationId).get();
  if (!locSnap.exists) return null;
  const loc = locSnap.data() || {};

  if (!loc.autoAcceptGuests) return null;

  // Must NOT have an active guest
  if (await hasActiveVisit(locationId)) return null;

  // Respect grace window
  const graceUntilMs = toMillis(loc.graceUntil);
  if (graceUntilMs && Date.now() < graceUntilMs) return null;

  // Promote oldest queued guest (support both requested + pending)
  const queuedSnap = await guestVisitsCol
    .where("locationId", "==", locationId)
    .where("status", "in", ["requested", "pending"])
    .orderBy("createdAt", "asc")
    .limit(1)
    .get();

  if (queuedSnap.empty) return null;

  const doc = queuedSnap.docs[0];
  const queued = doc.data() || {};

  const now = admin.firestore.Timestamp.now();
  const maxMinutes = Number(queued.maxDurationMinutes || 8);
  const expiresAt = admin.firestore.Timestamp.fromMillis(
    Date.now() + maxMinutes * 60 * 1000
  );

  await doc.ref.set(
    {
      status: "active",
      startTime: queued.startTime || now,
      expiresAt: queued.expiresAt || expiresAt,
      // IMPORTANT: set accessCode/instructions so MyPass can show it
      accessCode: loc.accessCode || queued.accessCode || null,
      instructions: loc.instructions || queued.instructions || null,
      updatedAt: now,
    },
    { merge: true }
  );

  return {
    id: doc.id,
    ...queued,
    status: "active",
    startTime: queued.startTime || now,
    expiresAt: queued.expiresAt || expiresAt,
    accessCode: loc.accessCode || queued.accessCode || null,
    instructions: loc.instructions || queued.instructions || null,
  };
}

/**
 * GET /api/payments/prices
 */
router.get("/prices", protect, async (req, res) => {
  try {
    const prices = await payments.getNormalizedPrices();
    res.json({ prices });
  } catch (err) {
    console.error("Error fetching prices:", err);
    res.status(500).json({ error: "Failed to fetch prices" });
  }
});

/**
 * POST /api/payments/subscriptions
 */
router.post(
  "/subscriptions",
  protect,
  [body("priceId", "priceId is required").notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { priceId } = req.body;
      const session = await payments.createCheckoutSession({
        priceId,
        mode: "subscription",
        user: req.user,
      });
      res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
      console.error("subscription checkout error:", err);
      res.status(500).json({ error: "Failed to create subscription checkout session" });
    }
  }
);

/**
 * POST /api/payments/one-time
 */
router.post(
  "/one-time",
  protect,
  [body("priceId", "priceId is required").notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { priceId } = req.body;
      const session = await payments.createCheckoutSession({
        priceId,
        mode: "payment",
        user: req.user,
      });
      res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
      console.error("one-time checkout error:", err);
      res.status(500).json({ error: "Failed to create one-time checkout session" });
    }
  }
);

/**
 * POST /api/payments/guest/checkout
 */
router.post(
  "/guest/checkout",
  protect,
  [
    body("locationId", "locationId is required").notEmpty(),
    body("price", "price must be a positive number").isFloat({ min: 0.5 }),
    body("name").optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { locationId, price, name } = req.body;
      const userId = req.user.id || req.user.userId;
      const email = req.user.email;

      if (!userId) return res.status(400).json({ error: "Missing user id" });

      const locSnap = await locationsCol.doc(locationId).get();
      if (!locSnap.exists) return res.status(404).json({ error: "Location not found" });
      const loc = locSnap.data() || {};

      const unitAmount = Math.round(Number(price) * 100);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: email || undefined,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: name || `Bathroom pass - ${loc.name || "location"}` },
              unit_amount: unitAmount,
            },
            quantity: 1,
          },
        ],
        metadata: { locationId, userId },
        success_url: `${process.env.CLIENT_URL}/#/mypass?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/#/home`,
      });

      return res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
      console.error("guest checkout error:", err);
      return res.status(500).json({ error: err.message || "Failed to create guest checkout session" });
    }
  }
);

/**
 * GET /api/payments/guest/session/:sessionId
 *
 * NOT protected (Stripe redirect / in-app browser may not have JWT)
 * Returns:
 * { session, location, visit, queuePosition, guestsAhead, graceSecondsRemaining }
 */
router.get("/guest/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const metadata = session.metadata || {};
    const locationId = metadata.locationId;
    const userId = metadata.userId || null;

    if (!locationId) {
      return res.status(400).json({ error: "Session metadata missing locationId" });
    }

    const locRef = locationsCol.doc(locationId);
    const locSnap = await locRef.get();
    if (!locSnap.exists) {
      return res.status(404).json({ error: "Location not found for this pass" });
    }

    const location = { id: locSnap.id, ...locSnap.data() };
    const autoAcceptGuests = !!location.autoAcceptGuests;
    const partnerId = location.owner || null;

    // Find existing visit for this session
    const existingVisitSnap = await guestVisitsCol
      .where("stripeSessionId", "==", session.id)
      .limit(1)
      .get();

    const now = admin.firestore.Timestamp.now();
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const todayName = dayNames[new Date().getDay()];

    let visitDoc = null;

    // If visit exists, refresh status if expired
    const maybeExpireVisit = async (docId, data) => {
      if (
        data.status === "active" &&
        data.expiresAt &&
        typeof data.expiresAt.toDate === "function"
      ) {
        const expDate = data.expiresAt.toDate();
        if (new Date() > expDate) {
          // End + start grace
          await guestVisitsCol.doc(docId).set(
            {
              status: "expired",
              endTime: admin.firestore.Timestamp.fromDate(expDate),
              updatedAt: admin.firestore.Timestamp.now(),
            },
            { merge: true }
          );

          await setGraceWindow(data.locationId);

          return {
            ...data,
            status: "expired",
            endTime: admin.firestore.Timestamp.fromDate(expDate),
          };
        }
      }
      return data;
    };

    if (!existingVisitSnap.empty) {
      const doc = existingVisitSnap.docs[0];
      let data = doc.data() || {};
      data = await maybeExpireVisit(doc.id, data);

      visitDoc = { id: doc.id, ...data };
    } else {
      // Create visit only if paid
      const isPaid =
        session.payment_status === "paid" ||
        session.payment_status === "no_payment_required";

      if (!isPaid) {
        const graceInfo = await computeGrace(locationId);
        return res.json({
          session: {
            id: session.id,
            status: session.payment_status,
            amountTotal: session.amount_total,
            currency: session.currency,
          },
          location,
          visit: null,
          queuePosition: null,
          guestsAhead: null,
          graceSecondsRemaining: graceInfo.graceSecondsRemaining,
        });
      }

      const maxDurationMinutes = 8;

      const activeExists = await hasActiveVisit(locationId);
      const graceUntilMs = toMillis(location.graceUntil);
      const graceActive = graceUntilMs && graceUntilMs > now.toMillis();

      // ✅ correct: can start only if autoAccept ON, no active, no grace
      const canStartNow = autoAcceptGuests && !activeExists && !graceActive;

      // IMPORTANT: partnerRoutes uses requested/active (keep compat with pending too)
      const visitStatus = canStartNow ? "active" : "requested";

      const startTime = canStartNow ? now : null;
      const expiresAt = canStartNow
        ? admin.firestore.Timestamp.fromMillis(now.toMillis() + maxDurationMinutes * 60 * 1000)
        : null;

      const visitData = {
        stripeSessionId: session.id,
        userId,
        locationId,
        partnerId,
        status: visitStatus,
        amountTotal: session.amount_total,
        currency: session.currency,

        startTime,
        endTime: null,
        maxDurationMinutes,
        expiresAt,

        // if auto-activated, stamp accessCode now so MyPass shows it
        accessCode: canStartNow ? location.accessCode || null : null,
        instructions: canStartNow ? location.instructions || null : null,

        dayOfWeek: todayName,
        passType: "one-time",

        createdAt: now,
        updatedAt: now,
      };

      const newRef = await guestVisitsCol.add(visitData);
      const newSnap = await newRef.get();
      visitDoc = { id: newRef.id, ...newSnap.data() };

      // Optional: if auto-accept is on, and conditions allow, promote next queued guest.
      // (Mostly useful if something just ended and grace is already over.)
      if (autoAcceptGuests) {
        await maybePromoteNextQueued(locationId);
      }

      // Notifications (kept)
      try {
        if (userId) {
          await createNotification({
            userId,
            userType: "guest",
            type: "GUEST_BOOKING_CONFIRMED",
            title: "Bathroom booked",
            body: `Your visit to ${location.name || "this bathroom"} is confirmed.`,
            data: { guestVisitId: newRef.id, locationId },
          });

          await createNotification({
            userId,
            userType: "guest",
            type: "GUEST_TIME_WARNING",
            title: "Time almost up",
            body: `Your visit to ${location.name || "this bathroom"} is almost over.`,
            data: { guestVisitId: newRef.id, locationId, expiresAt },
          });
        }

        if (partnerId) {
          await createNotification({
            userId: partnerId,
            userType: "partner",
            type: "PARTNER_NEW_BOOKING",
            title: "New booking",
            body: "A guest just booked your bathroom.",
            data: { guestVisitId: newRef.id, locationId },
          });
        }
      } catch (notifyErr) {
        console.error("Error creating booking notifications:", notifyErr);
      }
    }

    // Compute queue info for MyPass
    let queuePosition = null;
    let guestsAhead = null;

    try {
      if (visitDoc?.locationId) {
        const queueSnap = await guestVisitsCol
          .where("locationId", "==", visitDoc.locationId)
          .where("status", "in", ["requested", "pending", "active"])
          .orderBy("createdAt", "asc")
          .get();

        const queue = queueSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const idx = queue.findIndex((v) => v.id === visitDoc.id);

        if (idx !== -1) {
          queuePosition = idx + 1;
          guestsAhead = idx;
        }
      }
    } catch (queueErr) {
      console.error("Error computing queue for visit:", queueErr);
    }

    const graceInfo = await computeGrace(locationId);

    return res.json({
      session: {
        id: session.id,
        status: session.payment_status,
        amountTotal: session.amount_total,
        currency: session.currency,
      },
      location,
      visit: visitDoc,
      queuePosition,
      guestsAhead,
      graceSecondsRemaining: graceInfo.graceSecondsRemaining,
    });
  } catch (err) {
    console.error("guest session lookup error:", err);
    return res.status(500).json({ error: err.message || "Failed to load session / pass details" });
  }
});

/**
 * POST /api/payments/guest/visit/:visitId/end
 * Guest ends an active visit -> starts grace window
 */
router.post("/guest/visit/:visitId/end", protect, async (req, res) => {
  const { visitId } = req.params;
  const userId = req.user.id || req.user.userId;

  try {
    const visitRef = guestVisitsCol.doc(visitId);
    const snap = await visitRef.get();

    if (!snap.exists) return res.status(404).json({ error: "Visit not found" });

    const visit = snap.data() || {};
    if (visit.userId !== userId) {
      return res.status(403).json({ error: "You are not allowed to end this visit" });
    }

    if (visit.status !== "active") {
      return res.status(400).json({ error: "Visit is not active" });
    }

    const now = admin.firestore.Timestamp.now();

    await visitRef.set(
      {
        status: "completed",
        endTime: now,
        updatedAt: now,
      },
      { merge: true }
    );

    // ✅ start grace window on the location
    if (visit.locationId) {
      await setGraceWindow(visit.locationId);
    }

    // Thank-you notification (kept)
    try {
      await createNotification({
        userId,
        userType: "guest",
        type: "GUEST_THANK_YOU",
        title: "Thanks for your visit",
        body: "Thanks for using Pay2Pee today.",
        data: { guestVisitId: visitId, locationId: visit.locationId || null },
      });
    } catch (notifyErr) {
      console.error("Error creating thank-you notification:", notifyErr);
    }

    const graceInfo = await computeGrace(visit.locationId);

    return res.json({
      id: visitId,
      status: "completed",
      endTime: now,
      graceSecondsRemaining: graceInfo.graceSecondsRemaining ?? GRACE_SECONDS,
    });
  } catch (err) {
    console.error("End visit error:", err);
    return res.status(500).json({ error: err.message || "Failed to end visit" });
  }
});

module.exports = router;
