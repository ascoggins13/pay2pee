// routes/users.js
const express = require('express');
const { body, validationResult } = require('express-validator');

const router = express.Router();

const protect = require('../middleware/protect');
const { admin, firestore } = require('../firebase-admin');

const usersCol = firestore.collection('users');
const guestVisitsCol = firestore.collection('guestVisits');
const locationsCol = firestore.collection('locations');
const FieldValue = admin.firestore.FieldValue;

/**
 * Small helper: safely get timestamp -> ISO string
 */
function tsToIso(ts) {
  if (!ts) return null;
  try {
    if (typeof ts.toDate === 'function') {
      return ts.toDate().toISOString();
    }
    if (ts instanceof Date) {
      return ts.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GET /profile
 *
 * Returns the guest's profile data:
 * - name, email, avatarUrl, jobTitle, memberSince
 * - preferences
 * - favorites (resolved from locations collection)
 * - recentVisits (last 10 visits from guestVisits)
 * - totalSavings (simple calculated metric)
 *
 * This is what the GuestProfile screen should call.
 */
router.get('/profile', protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Load base user document
    const userSnap = await usersCol.doc(userId).get();
    const userData = userSnap.exists ? userSnap.data() : {};

    const name =
      userData.name ||
      (userData.email ? userData.email.split('@')[0] : 'Guest');
    const email = userData.email || null;
    const avatarUrl = userData.avatarUrl || '';
    const jobTitle = userData.jobTitle || '';
    const memberSince =
      userData.memberSince || (userData.createdAt && tsToIso(userData.createdAt));

    // Preferences stored on user doc as an object
    const preferences = userData.preferences || {
      cleanliness: true,
      accessibility: true,
      familyFriendly: false,
      openLate: true,
    };

    // Favorites stored as an array of location IDs on the user doc
    const favoriteIds = Array.isArray(userData.favorites)
      ? userData.favorites
      : [];

    let favorites = [];
    if (favoriteIds.length > 0) {
      const locDocs = await Promise.all(
        favoriteIds.map((id) => locationsCol.doc(id).get())
      );

      favorites = locDocs
        .filter((snap) => snap.exists)
        .map((snap) => {
          const loc = snap.data() || {};
          return {
            id: snap.id,
            name: loc.name || 'Bathroom',
            area: loc.area || null,
            address: loc.address || null,
          };
        });
    }

    // Recent visits from guestVisits collection
const visitsSnap = await guestVisitsCol
.where("userId", "==", userId)
.orderBy("createdAt", "desc")
.limit(50) // bump to 50 so your cards have more data; change as you like
.get();

// 1) Collect unique locationIds from visits
const locationIds = new Set();
visitsSnap.forEach((doc) => {
const v = doc.data() || {};
if (v.locationId) locationIds.add(v.locationId);
});

// 2) Fetch all those locations in parallel (no async inside forEach)
const locationMap = {};
await Promise.all(
Array.from(locationIds).map(async (locId) => {
  const locSnap = await locationsCol.doc(locId).get();
  if (locSnap.exists) locationMap[locId] = locSnap.data() || {};
})
);

// 3) Build recentVisits now that locationMap is ready
const recentVisits = [];
let totalSpentCents = 0;

visitsSnap.forEach((doc) => {
const v = doc.data() || {};

// Price calc (same as before)
let price = null;
if (typeof v.amountTotal === "number") {
  price = v.amountTotal / 100;
  totalSpentCents += v.amountTotal;
} else {
  const rawPrice =
    typeof v.price === "number"
      ? v.price
      : typeof v.amount === "number"
      ? v.amount
      : null;

  if (typeof rawPrice === "number") {
    price = rawPrice;
    totalSpentCents += Math.round(rawPrice * 100);
  }
}

// Pull matched location doc
const loc = v.locationId ? (locationMap[v.locationId] || {}) : {};

// Review fields (your current UI expects v.review?.rating / v.review?.text)
const reviewRating =
  typeof v.reviewRating === "number" ? v.reviewRating : null;
const reviewText = typeof v.reviewText === "string" ? v.reviewText : "";

recentVisits.push({
  id: doc.id,
  locationId: v.locationId || null,

  // ✅ best available name/address (visit fields OR location doc)
  name:
    v.locationName ||
    (v.location && v.location.name) ||
    loc.name ||
    "Bathroom",

  address:
    v.locationAddress ||
    (v.location && v.location.address) ||
    loc.address ||
    v.address ||
    "",

  date: tsToIso(v.createdAt),
  price,

  // ✅ match the shape your frontend is using
  review:
    reviewRating || reviewText
      ? { rating: reviewRating, text: reviewText }
      : null,
});
});

    // Simple "savings" metric: 20% of total spent (you can adjust later)
    const totalSpent = totalSpentCents / 100;
    const totalSavings = Number((totalSpent * 0.2).toFixed(2));

    return res.json({
      userId,
      uid: userId,   // ✅ alias (many clients expect uid)
      id: userId,    // ✅ alias (some UI expects id)
      name,
      email,
      avatarUrl,
      jobTitle,
      memberSince,
      preferences,
      favorites,
      recentVisits,
      totalSavings,
    });
  } catch (err) {
    console.error('GET /users/profile error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /preferences
 *
 * Save guest restroom preferences on the user document.
 * Body can be any subset, e.g.:
 * {
 *   cleanliness: true,
 *   accessibility: false,
 *   familyFriendly: true,
 *   openLate: true
 * }
 */
router.post(
  '/preferences',
  protect,
  [
    body('cleanliness').optional().isBoolean(),
    body('accessibility').optional().isBoolean(),
    body('familyFriendly').optional().isBoolean(),
    body('openLate').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const prefs = req.body || {};

      // Merge with existing preferences
      const userSnap = await usersCol.doc(userId).get();
      const existing = userSnap.exists ? userSnap.data().preferences || {} : {};

      const updated = { ...existing, ...prefs };

      await usersCol.doc(userId).set(
        {
          preferences: updated,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.json({ preferences: updated });
    } catch (err) {
      console.error('POST /users/preferences error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * POST /favorites
 *
 * Add a favorite location for this guest.
 * Body:
 *   { "locationId": "abc123" }
 *
 * Favorites are stored as an array of location IDs on the user doc.
 * We return the updated favorites array, resolved with location names.
 */
router.post(
  '/favorites',
  protect,
  [body('locationId').isString().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const { locationId } = req.body;

      // Add ID to favorites array
      await usersCol.doc(userId).set(
        {
          favorites: FieldValue.arrayUnion(locationId),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Reload user and resolve favorites
      const userSnap = await usersCol.doc(userId).get();
      const userData = userSnap.exists ? userSnap.data() : {};
      const favoriteIds = Array.isArray(userData.favorites)
        ? userData.favorites
        : [];

      let favorites = [];
      if (favoriteIds.length > 0) {
        const locDocs = await Promise.all(
          favoriteIds.map((id) => locationsCol.doc(id).get())
        );

        favorites = locDocs
          .filter((snap) => snap.exists)
          .map((snap) => {
            const loc = snap.data() || {};
            return {
              id: snap.id,
              name: loc.name || 'Bathroom',
              area: loc.area || null,
              address: loc.address || null,
            };
          });
      }

      return res.json({ favorites });
    } catch (err) {
      console.error('POST /users/favorites error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * DELETE /favorites/:locationId
 *
 * Remove a favorite location for this guest.
 */
router.delete('/favorites/:locationId', protect, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { locationId } = req.params;

    if (!locationId || typeof locationId !== 'string') {
      return res.status(400).json({ error: 'locationId is required' });
    }

    await usersCol.doc(userId).set(
      {
        favorites: FieldValue.arrayRemove(locationId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Reload updated favorites
    const userSnap = await usersCol.doc(userId).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const favoriteIds = Array.isArray(userData.favorites)
      ? userData.favorites
      : [];

    let favorites = [];
    if (favoriteIds.length > 0) {
      const locDocs = await Promise.all(
        favoriteIds.map((id) => locationsCol.doc(id).get())
      );

        favorites = locDocs
        .filter((snap) => snap.exists)
        .map((snap) => {
          const loc = snap.data() || {};
          return {
            id: snap.id,
            name: loc.name || 'Bathroom',
            area: loc.area || null,
            address: loc.address || null,
          };
        });
    }

    return res.json({ favorites });
  } catch (err) {
    console.error('DELETE /users/favorites/:locationId error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Legacy placeholder (optional – you can keep or drop this)
 */
router.get('/', (req, res) => {
  res.send('User route: profile, preferences, favorites endpoints are active.');
});
/**
 * PUT /profile
 *
 * Saves guest profile fields on the user document:
 * - name, jobTitle, avatarUrl
 */
router.put(
  "/profile",
  protect,
  [
    body("name").optional().isString().trim().isLength({ min: 1, max: 60 }),
    body("jobTitle").optional().isString().trim().isLength({ max: 80 }),
    body("avatarUrl").optional().isString().trim().isLength({ max: 2000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const userId = req.user.userId;
      const { name, jobTitle, avatarUrl } = req.body || {};

      const update = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (typeof name === "string") update.name = name;
      if (typeof jobTitle === "string") update.jobTitle = jobTitle;

      // IMPORTANT: store URL string here (NOT huge base64)
      if (typeof avatarUrl === "string") update.avatarUrl = avatarUrl;

      await usersCol.doc(userId).set(update, { merge: true });

      // return fresh profile snapshot (simple + helpful)
      const snap = await usersCol.doc(userId).get();
      const userData = snap.exists ? snap.data() : {};

      return res.json({
        userId,
        name:
          userData.name ||
          (userData.email ? userData.email.split("@")[0] : "Guest"),
        email: userData.email || null,
        avatarUrl: userData.avatarUrl || "",
        jobTitle: userData.jobTitle || "",
        memberSince:
          userData.memberSince ||
          (userData.createdAt && tsToIso(userData.createdAt)) ||
          null,
      });
    } catch (err) {
      console.error("PUT /users/profile error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

router.post("/avatar", protect, upload.single("file"), async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!req.file) return res.status(400).json({ error: "Missing file" });

    // firebase-admin storage bucket
    const bucket = admin.storage().bucket(); // uses default bucket from firebase-admin init
    const filePath = `users/${userId}/avatar.jpg`;

    const file = bucket.file(filePath);

    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype || "image/jpeg" },
      resumable: false,
    });

    // Option A: make public (fastest)
    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    // Save URL on user doc
    await usersCol.doc(userId).set(
      { avatarUrl: publicUrl, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    return res.json({ avatarUrl: publicUrl, uid: userId, userId });
  } catch (err) {
    console.error("POST /users/avatar error:", err);
    return res.status(500).json({ error: "Avatar upload failed" });
  }
});
module.exports = router;

