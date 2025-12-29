// routes/locationRoutes.js (GeoPoint-safe + fixes nearby crash)
const express = require("express");
const { body, validationResult } = require("express-validator");
const { admin, firestore } = require("../firebase-admin");
const protect = require("../middleware/protect");

const router = express.Router();
const locationsCol = firestore.collection("locations");

// ✅ Normalize Firestore coordinate shapes into { lat, lng } for the frontend map
function normalizeCoordinates(raw) {
  if (!raw) return null;

  // Firestore GeoPoint
  if (
    typeof raw === "object" &&
    typeof raw.latitude === "number" &&
    typeof raw.longitude === "number" &&
    raw._latitude === undefined // (avoid some weird serialized shapes)
  ) {
    return { lat: raw.latitude, lng: raw.longitude };
  }

  // If it was stored as { latitude, longitude }
  if (
    typeof raw === "object" &&
    typeof raw.latitude === "number" &&
    typeof raw.longitude === "number"
  ) {
    return { lat: raw.latitude, lng: raw.longitude };
  }

  // If it was stored as { lat, lng }
  if (typeof raw === "object" && typeof raw.lat === "number" && typeof raw.lng === "number") {
    return { lat: raw.lat, lng: raw.lng };
  }

  // If it was stored as strings
  if (
    typeof raw === "object" &&
    raw.latitude != null &&
    raw.longitude != null &&
    !Number.isNaN(parseFloat(raw.latitude)) &&
    !Number.isNaN(parseFloat(raw.longitude))
  ) {
    return { lat: parseFloat(raw.latitude), lng: parseFloat(raw.longitude) };
  }

  if (
    typeof raw === "object" &&
    raw.lat != null &&
    raw.lng != null &&
    !Number.isNaN(parseFloat(raw.lat)) &&
    !Number.isNaN(parseFloat(raw.lng))
  ) {
    return { lat: parseFloat(raw.lat), lng: parseFloat(raw.lng) };
  }

  return null;
}

/* ─────────────────────────────────────────────
 * GET /api/locations/nearby
 *
 * Returns active locations and normalizes coordinates for map pins.
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
      const data = doc.data() || {};

      // Optional: hide non-public if you want guests to only see public
      // (won’t break docs that don’t have isPublic)
      if (data.isPublic === false) return;

      const coords = normalizeCoordinates(data.coordinates);

      locations.push({
        id: doc.id,
        ...data,
        coordinates: coords, // ✅ frontend expects {lat,lng} (or null)
      });
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
 * Expects coordinates like { latitude, longitude } OR { lat, lng }
 */
router.put(
  "/me",
  protect,
  [
    body("address").not().isEmpty().withMessage("Address is required"),
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

      // Store coordinates as-is (GeoPoint or object). Frontend gets normalized via /nearby.
      const payload = {
        owner: req.user.userId,
        address,
        coordinates: coordinates || null,
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
