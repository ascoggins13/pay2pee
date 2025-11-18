// routes/locationRoutes.js (super simple, GeoPoint-safe)
const express = require("express");
const { body, validationResult } = require("express-validator");
const { admin, firestore } = require("../firebase-admin");
const protect = require("../middleware/protect");

const router = express.Router();
const locationsCol = firestore.collection("locations");

/* ─────────────────────────────────────────────
 * GET /api/locations/nearby
 *
 * Query (optional):
 *   lat, lng, radiusKm – IGNORED for now, we just return active locations.
 *
 * Returns:
 *   { locations: [ { id, ...doc.data() }, ... ] }
 * ────────────────────────────────────────────*/
router.get("/nearby", async (req, res) => {
  try {
    console.log("GET /api/locations/nearby raw hit");

    const snap = await locationsCol
      .where("isActive", "==", true)
      .limit(200)
      .get();

    const locations = [];
    snap.forEach((doc) => {
      try {
        const data = doc.data() || {};
        // Just spread everything, including GeoPoint, photos, etc.
        locations.push({
          id: doc.id,
          ...data,
        });
      } catch (docErr) {
        console.error(
          `Error processing location doc ${doc.id}:`,
          docErr?.message || docErr
        );
      }
    });

    return res.json({ locations });
  } catch (err) {
    console.error("GET /locations/nearby error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ─────────────────────────────────────────────
 * Partner-facing routes (unchanged)
 * ────────────────────────────────────────────*/

/**
 * GET /api/locations/me (partner)
 */
router.get("/me", protect, async (req, res) => {
  try {
    const snap = await locationsCol
      .where("owner", "==", req.user.userId)
      .limit(1)
      .get();

    if (snap.empty) return res.status(404).json({ error: "Location not found" });

    res.json({ id: snap.docs[0].id, ...snap.docs[0].data() });
  } catch (e) {
    console.error("Get location error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /api/locations/me (partner)
 * Expects coordinates like { latitude, longitude }
 */
router.put(
  "/me",
  protect,
  [
    body("address").not().isEmpty().withMessage("Address is required"),
    body("coordinates.latitude").isFloat({ min: -90, max: 90 }),
    body("coordinates.longitude").isFloat({ min: -180, max: 180 }),
    body("pricing.basePrice").isFloat({ min: 0 }),
    body("pricing.surgeMultiplier").optional().isFloat({ min: 1 }),
    body("isPublic").optional().isBoolean(),
    body("isActive").optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const {
        address,
        coordinates,
        pricing,
        amenities = [],
        isPublic = false,
        isActive = false,
      } = req.body;

      const payload = {
        owner: req.user.userId,
        address,
        coordinates, // { latitude, longitude } or GeoPoint-like object
        pricing: {
          basePrice: pricing.basePrice,
          surgeMultiplier: pricing.surgeMultiplier || 1,
        },
        amenities,
        isPublic,
        isActive,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const snap = await locationsCol
        .where("owner", "==", req.user.userId)
        .limit(1)
        .get();

      if (snap.empty) {
        const docRef = await locationsCol.add({
          ...payload,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return res.status(201).json({ id: docRef.id, ...payload });
      } else {
        const ref = snap.docs[0].ref;
        await ref.set(payload, { merge: true });
        const updated = await ref.get();
        return res.json({ id: ref.id, ...updated.data() });
      }
    } catch (e) {
      console.error("Update location error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * POST /api/locations/me/photos (partner)
 */
router.post(
  "/me/photos",
  protect,
  [body("url").isURL()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const snap = await locationsCol
        .where("owner", "==", req.user.userId)
        .limit(1)
        .get();
      if (snap.empty)
        return res.status(404).json({ error: "Location not found" });

      const ref = snap.docs[0].ref;
      await ref.set(
        {
          photos: admin.firestore.FieldValue.arrayUnion({
            url: req.body.url,
            uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
          }),
        },
        { merge: true }
      );
      const updated = await ref.get();
      res.json(updated.data().photos || []);
    } catch (e) {
      console.error("Add photo error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * PUT /api/locations/me/status (partner)
 */
router.put(
  "/me/status",
  protect,
  [body("isActive").isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const snap = await locationsCol
        .where("owner", "==", req.user.userId)
        .limit(1)
        .get();
      if (snap.empty)
        return res.status(404).json({ error: "Location not found" });

      const ref = snap.docs[0].ref;
      await ref.set({ isActive: req.body.isActive }, { merge: true });
      const updated = await ref.get();
      res.json({ id: ref.id, ...updated.data() });
    } catch (e) {
      console.error("Update status error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

module.exports = router;
