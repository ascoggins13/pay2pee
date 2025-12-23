// routes/guestVisitsRoutes.js
const express = require("express");
const protect = require("../middleware/protect");
const { admin, firestore } = require("../firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const db = firestore;
const router = express.Router();

const GRACE_SECONDS = 180;

// ---- helpers ----
const tsToMillis = (t) => {
  if (!t) return null;
  if (typeof t === "number") return t;
  if (typeof t === "string") {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  if (t?._seconds) return t._seconds * 1000;
  if (typeof t?.toMillis === "function") return t.toMillis();
  return null;
};

const nowMs = () => Date.now();
const secondsLeft = (futureTs) => {
  const ms = tsToMillis(futureTs);
  if (!ms) return null;
  return Math.max(0, Math.floor((ms - nowMs()) / 1000));
};

async function finalizeIfExpiredActiveVisit(tx, activeVisitDoc, locationRef) {
  // If active visit has expiresAt and it's expired, end it + start grace window
  const v = activeVisitDoc.data();
  const expMs = tsToMillis(v.expiresAt);
  if (!expMs) return { ended: false };

  if (nowMs() < expMs) return { ended: false };

  // End the visit
  tx.update(activeVisitDoc.ref, {
    status: "completed",
    endTime: admin.firestore.Timestamp.now(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Start grace on location
  tx.set(
    locationRef,
    {
      graceEndsAt: admin.firestore.Timestamp.fromMillis(
        nowMs() + GRACE_SECONDS * 1000
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { ended: true };
}

/**
 * GET /api/guest/visits/current
 * Returns the most recent requested/active visit for this user,
 * plus queue position info for the location + graceSecondsRemaining.
 */
router.get("/visits/current", protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Find most recent requested/active visit
    const snap = await db
      .collection("guestVisits")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();

    if (snap.empty) {
      return res.json({ visit: null });
    }

    let visitDoc = null;
    snap.forEach((doc) => {
      const v = doc.data();
      if (v.status === "requested" || v.status === "active") {
        if (!visitDoc) visitDoc = { id: doc.id, ...v };
      }
    });

    if (!visitDoc) {
      return res.json({ visit: null });
    }

    const visit = visitDoc;

    // Pull location (for grace window + accessCode fallback)
    const locRef = db.collection("locations").doc(visit.locationId);
    const locSnap = await locRef.get();
    const loc = locSnap.exists ? locSnap.data() : null;

    // If this visit is active but expired, lazily finalize it + start grace
    // (This keeps things consistent even without a background job.)
    if (visit.status === "active" && visit.expiresAt) {
      const expMs = tsToMillis(visit.expiresAt);
      if (expMs && nowMs() >= expMs) {
        await db.runTransaction(async (tx) => {
          const vref = db.collection("guestVisits").doc(visit.id);
          const vSnap = await tx.get(vref);
          if (!vSnap.exists) return;

          const latest = vSnap.data();
          if (latest.status !== "active") return;

          const exp2 = tsToMillis(latest.expiresAt);
          if (exp2 && nowMs() >= exp2) {
            tx.update(vref, {
              status: "completed",
              endTime: admin.firestore.Timestamp.now(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            tx.set(
              locRef,
              {
                graceEndsAt: admin.firestore.Timestamp.fromMillis(
                  nowMs() + GRACE_SECONDS * 1000
                ),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
        });

        // After finalize, return "visit: null" because pass is no longer active/requested
        return res.json({ visit: null });
      }
    }

    // Compute queue position at this location (requested + active, ordered by createdAt)
    const queueSnap = await db
      .collection("guestVisits")
      .where("locationId", "==", visit.locationId)
      .orderBy("createdAt", "asc")
      .get();

    let position = 1;
    let ahead = 0;

    queueSnap.forEach((doc) => {
      const v = doc.data();
      if (doc.id === visit.id) return;

      if (v.status === "requested" || v.status === "active") {
        const vMs = tsToMillis(v.createdAt);
        const myMs = tsToMillis(visit.createdAt);

        if (vMs !== null && myMs !== null && vMs <= myMs) {
          ahead += 1;
          position += 1;
        }
      }
    });

    const graceSecondsRemaining = loc?.graceEndsAt
      ? secondsLeft(loc.graceEndsAt)
      : null;

    const response = {
      id: visit.id,
      status: visit.status,
      locationId: visit.locationId,
      locationName: visit.locationName,
      locationAddress: visit.locationAddress,
      price: visit.price,
      partnerId: visit.partnerId,

      queuePosition: position,
      guestsAhead: ahead,

      // timing (for countdown)
      startTime: visit.startTime || null,
      expiresAt: visit.expiresAt || null,
      maxDurationMinutes: visit.maxDurationMinutes || null,

      // grace (so MyPass can show "Starting after cleaning…")
      graceSecondsRemaining,

      // access (only when active)
      accessCode:
        visit.status === "active"
          ? visit.accessCode || loc?.accessCode || null
          : null,
      instructions:
        visit.status === "active" ? visit.instructions || null : null,

      createdAt: visit.createdAt,
    };

    return res.json({ visit: response });
  } catch (err) {
    console.error("GET /guest/visits/current error:", err);
    return res.status(500).json({ error: "Failed to load current pass" });
  }
});

/**
 * POST /api/guest/visits/confirm-session
 * Body: { sessionId }
 * Called from the frontend success page to create a guestVisit after Stripe payment.
 *
 * IMPORTANT: Stripe Checkout session must have session.metadata.locationId
 */
router.post("/visits/confirm-session", protect, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user.userId;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    // Idempotency: already created?
    const existingSnap = await db
      .collection("guestVisits")
      .where("stripeSessionId", "==", sessionId)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      const doc = existingSnap.docs[0];
      const visit = { id: doc.id, ...doc.data() };
      return res.json({
        success: true,
        visitId: visit.id,
        status: visit.status,
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: "Session is not paid" });
    }

    const locationId = session.metadata && session.metadata.locationId;
    if (!locationId) {
      return res
        .status(400)
        .json({ error: "Missing locationId on session metadata" });
    }

    const locRef = db.collection("locations").doc(locationId);

    const result = await db.runTransaction(async (tx) => {
      const locSnap = await tx.get(locRef);
      if (!locSnap.exists) {
        return { error: "Location not found", code: 404 };
      }

      const loc = locSnap.data();

      const partnerId = loc.owner;
      const autoAccept = !!loc.autoAcceptGuests;

      const price =
        loc.pricing && typeof loc.pricing.basePrice === "number"
          ? loc.pricing.basePrice
          : typeof loc.price === "number"
          ? loc.price
          : 0;

      const maxDurationMinutes =
        typeof loc.maxDurationMinutes === "number"
          ? loc.maxDurationMinutes
          : typeof loc.maxDuration === "number"
          ? loc.maxDuration
          : 8; // fallback

      // Check grace
      const graceRemaining = loc.graceEndsAt
        ? secondsLeft(loc.graceEndsAt)
        : 0;

      // Check if there is an active visit at this location
      const activeQ = db
        .collection("guestVisits")
        .where("locationId", "==", locationId)
        .where("status", "==", "active")
        .limit(1);

      const activeSnap = await tx.get(activeQ);

      let hasBlockingActive = false;

      if (!activeSnap.empty) {
        const activeDoc = activeSnap.docs[0];

        // If expired, finalize it + start grace
        const ended = await finalizeIfExpiredActiveVisit(tx, activeDoc, locRef);
        if (!ended.ended) {
          hasBlockingActive = true;
        } else {
          // after ending we are now in grace
          hasBlockingActive = true;
        }
      }

      // Decide status:
      // Auto-accept ONLY if no grace running and no active visit blocking
      const canAutoAccept =
        autoAccept && !hasBlockingActive && (!graceRemaining || graceRemaining <= 0);

      const status = canAutoAccept ? "active" : "requested";

      const startTime = canAutoAccept
        ? admin.firestore.Timestamp.now()
        : null;

      const expiresAt = canAutoAccept
        ? admin.firestore.Timestamp.fromMillis(
            nowMs() + maxDurationMinutes * 60 * 1000
          )
        : null;

      const visitData = {
        userId,
        partnerId,
        locationId,
        status,
        locationName: loc.name || "Bathroom",
        locationAddress: loc.address || "",
        price: Number(price),

        // access only when active
        accessCode: canAutoAccept ? loc.accessCode || null : null,
        instructions: canAutoAccept ? loc.instructions || null : null,

        // timing for countdown + grace sequencing
        maxDurationMinutes,
        startTime,
        expiresAt,
        endTime: null,

        stripeSessionId: sessionId,
        paymentIntentId: session.payment_intent || null,

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const visitRef = db.collection("guestVisits").doc();
      tx.set(visitRef, visitData);

      return { success: true, visitId: visitRef.id, status };
    });

    if (result?.error) {
      return res.status(result.code || 400).json({ error: result.error });
    }

    return res.json(result);
  } catch (err) {
    console.error("POST /guest/visits/confirm-session error:", err);
    return res.status(500).json({ error: "Failed to confirm session" });
  }
});

module.exports = router;
