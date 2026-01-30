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
const partnersCol = firestore.collection("partners");

// ------------------------------
// ------------------------------
// Queue + Grace Period Helpers
// ------------------------------
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
  if (!locationId) return { graceEndsAt: null, graceSecondsRemaining: null };

  const locSnap = await locationsCol.doc(locationId).get();
  if (!locSnap.exists) return { graceEndsAt: null, graceSecondsRemaining: null };

  const graceEndsAt = locSnap.data()?.graceEndsAt || null;
  const graceMs = toMillis(graceEndsAt);
  if (!graceMs) return { graceEndsAt: null, graceSecondsRemaining: null };

  const remaining = Math.max(0, Math.ceil((graceMs - Date.now()) / 1000));
  return { graceEndsAt, graceSecondsRemaining: remaining };
}

async function setGraceWindow(locationId, tx) {
  if (!locationId) return null;

  const graceEndsAt = admin.firestore.Timestamp.fromMillis(
    Date.now() + GRACE_SECONDS * 1000
  );

  const ref = locationsCol.doc(locationId);

  const payload = {
    graceEndsAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (tx) tx.set(ref, payload, { merge: true });
  else await ref.set(payload, { merge: true });

  return graceEndsAt;
}

async function maybePromoteNextQueuedTransactional(locationId) {
  if (!locationId) return null;

  const locRef = locationsCol.doc(locationId);

  const promoted = await firestore.runTransaction(async (tx) => {
    const locSnap = await tx.get(locRef);
    if (!locSnap.exists) return null;

    const loc = locSnap.data() || {};
    if (!loc.autoAcceptGuests) return null;

    // lock: only one active at a time
    if (loc.currentActiveVisitId) return null;

    // respect grace
    const graceMs = toMillis(loc.graceEndsAt);
    if (graceMs && graceMs > Date.now()) return null;

    // find oldest queued (requested/pending)
    const q = guestVisitsCol
      .where("locationId", "==", locationId)
      .where("status", "in", ["requested", "pending"])
      .orderBy("createdAt", "asc")
      .limit(1);

    const qSnap = await tx.get(q);
    if (qSnap.empty) return null;

    const doc = qSnap.docs[0];
    const queued = doc.data() || {};

    const now = admin.firestore.Timestamp.now();
    const maxMinutes = Number(queued.maxDurationMinutes || 8);
    const expiresAt = admin.firestore.Timestamp.fromMillis(
      now.toMillis() + maxMinutes * 60 * 1000
    );

    tx.set(
      doc.ref,
      {
        status: "active",
        startTime: now,
        expiresAt,
        accessCode: loc.accessCode || queued.accessCode || null,
        instructions: loc.instructions || queued.instructions || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      locRef,
      {
        currentActiveVisitId: doc.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { id: doc.id, ...queued, status: "active", startTime: now, expiresAt };
  });

  return promoted;
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

      const partnerId = loc.owner || null;
      if (!partnerId) return res.status(400).json({ error: "Location missing owner/partner" });

      const partnerSnap = await partnersCol.doc(partnerId).get();
      const partner = partnerSnap.exists ? partnerSnap.data() : {};
      const destinationAccountId = partner.stripeAccountId || null;

      if (!destinationAccountId) {
        return res.status(400).json({
          error: "Partner is not connected to Stripe yet. Complete onboarding first.",
        });
      }

      const unitAmount = Math.round(Number(price) * 100);
      const applicationFeeAmount = Math.round(unitAmount * 0.30); // 30% platform fee

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

        // ✅ This is the entire Connect fix:
        payment_intent_data: {
          application_fee_amount: applicationFeeAmount,
          transfer_data: {
            destination: destinationAccountId,
          },
        },

        metadata: { locationId, userId, partnerId, destinationAccountId },

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

    // Prefer deterministic doc id (prevents double-creation races)
    const deterministicVisitRef = guestVisitsCol.doc(session.id);
    const deterministicSnap = await deterministicVisitRef.get();

    // Back-compat: old systems may have random doc ids with stripeSessionId field
    let visitDoc = null;

    const maybeExpireVisit = async (docId, data) => {
      if (
        data.status === "active" &&
        data.expiresAt &&
        typeof data.expiresAt.toDate === "function"
      ) {
        const expDate = data.expiresAt.toDate();
        if (new Date() > expDate) {
          await firestore.runTransaction(async (tx) => {
            const vRef = guestVisitsCol.doc(docId);
            const lRef = locationsCol.doc(data.locationId);

            const [vSnap, lSnap] = await Promise.all([tx.get(vRef), tx.get(lRef)]);
            if (!vSnap.exists || !lSnap.exists) return;

            const lData = lSnap.data() || {};

            tx.set(
              vRef,
              {
                status: "expired",
                endTime: admin.firestore.Timestamp.fromDate(expDate),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            // clear active lock if it points to this visit
            if (lData.currentActiveVisitId === docId) {
              tx.set(
                lRef,
                { currentActiveVisitId: null },
                { merge: true }
              );
            }

            // start grace
            await setGraceWindow(data.locationId, tx);
          });

          return {
            ...data,
            status: "expired",
            endTime: admin.firestore.Timestamp.fromDate(expDate),
          };
        }
      }
      return data;
    };

    if (deterministicSnap.exists) {
      let data = deterministicSnap.data() || {};
      data = await maybeExpireVisit(deterministicSnap.id, data);
      visitDoc = { id: deterministicSnap.id, ...data };
    } else {
      // back-compat lookup
      const existingVisitSnap = await guestVisitsCol
        .where("stripeSessionId", "==", session.id)
        .limit(1)
        .get();

      if (!existingVisitSnap.empty) {
        const doc = existingVisitSnap.docs[0];
        let data = doc.data() || {};
        data = await maybeExpireVisit(doc.id, data);
        visitDoc = { id: doc.id, ...data };
      }
    }

    // If no visit yet, only create if paid
    if (!visitDoc) {
      const isPaid =
        session.payment_status === "paid" ||
        session.payment_status === "no_payment_required";

      const graceInfo = await computeGrace(locationId);

      if (!isPaid) {
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
      const now = admin.firestore.Timestamp.now();

      // Transaction: location lock prevents race
      await firestore.runTransaction(async (tx) => {
        const locLive = await tx.get(locRef);
        if (!locLive.exists) throw new Error("Location missing");

        const locData = locLive.data() || {};
        const graceMs = toMillis(locData.graceEndsAt);
          const graceActive = graceMs && graceMs > Date.now();;

        const canStartNow =
          !!locData.autoAcceptGuests &&
          !locData.currentActiveVisitId &&
          !graceActive;

        const status = canStartNow ? "active" : "requested";

        const startTime = canStartNow ? now : null;
        const expiresAt = canStartNow
          ? admin.firestore.Timestamp.fromMillis(now.toMillis() + maxDurationMinutes * 60 * 1000)
          : null;

        const visitData = {
          stripeSessionId: session.id,
          userId,
          locationId,
          partnerId,
          status,
          amountTotal: session.amount_total,
          currency: session.currency,

          startTime,
          endTime: null,
          maxDurationMinutes,
          expiresAt,

          accessCode: canStartNow ? locData.accessCode || null : null,
          instructions: canStartNow ? locData.instructions || null : null,

          dayOfWeek: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date().getDay()],
          passType: "one-time",

          createdAt: now,
          updatedAt: now,
        };

        tx.set(deterministicVisitRef, visitData, { merge: true });

        if (canStartNow) {
          tx.set(
            locRef,
            { currentActiveVisitId: deterministicVisitRef.id },
            { merge: true }
          );
        }
      });

      const createdSnap = await deterministicVisitRef.get();
      visitDoc = { id: createdSnap.id, ...(createdSnap.data() || {}) };

      // Notifications (non-transactional)
      try {
        if (userId) {
          await createNotification({
            userId,
            userType: "guest",
            type: "GUEST_BOOKING_CONFIRMED",
            title: "Bathroom booked",
            body: `Your visit to ${location.name || "this bathroom"} is confirmed.`,
            data: { guestVisitId: visitDoc.id, locationId },
          });

          await createNotification({
            userId,
            userType: "guest",
            type: "GUEST_TIME_WARNING",
            title: "Time almost up",
            body: `Your visit to ${location.name || "this bathroom"} is almost over.`,
            data: { guestVisitId: visitDoc.id, locationId, expiresAt: visitDoc.expiresAt || null },
          });
        }

        if (partnerId) {
          await createNotification({
            userId: partnerId,
            userType: "partner",
            type: "PARTNER_NEW_BOOKING",
            title: "New booking",
            body: "A guest just booked your bathroom.",
            data: { guestVisitId: visitDoc.id, locationId },
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

    // Opportunistic promote (only if grace is NOT active and no active lock)
    // This helps in edge cases where partner screen isn't open.
    await maybePromoteNextQueuedTransactional(locationId);

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
 * Guest ends an active visit -> starts grace window + clears active lock
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

    await firestore.runTransaction(async (tx) => {
      const vSnap = await tx.get(visitRef);
      if (!vSnap.exists) throw new Error("Visit missing");
      const vData = vSnap.data() || {};

      const locId = vData.locationId;
      const locRef = locId ? locationsCol.doc(locId) : null;
      const locSnap = locRef ? await tx.get(locRef) : null;
      const locData = locSnap?.exists ? locSnap.data() : null;

      tx.set(
        visitRef,
        {
          status: "completed",
          endTime: now,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (locRef && locData) {
        // clear lock if it points to this visit
        if (locData.currentActiveVisitId === visitId) {
          tx.set(locRef, { currentActiveVisitId: null }, { merge: true });
        }
        await setGraceWindow(locId, tx);
      }
    });

    // Thank-you notification
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
