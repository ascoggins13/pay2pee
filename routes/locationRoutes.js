// routes/locationRoutes.js (Firestore)
const express = require('express');
const { query, body, validationResult } = require('express-validator');
const geofire = require('geofire-common');
const { admin, firestore } = require('../firebase-admin');
const protect = require('../middleware/protect');

const router = express.Router();
const locationsCol = firestore.collection('locations');

/* ─────────────────────────────────────────────
 * Distance helpers
 * ────────────────────────────────────────────*/
const toRad = (value) => (value * Math.PI) / 180;

const haversineKm = (lat1, lng1, lat2, lng2) => {
  if (
    typeof lat1 !== 'number' ||
    typeof lng1 !== 'number' ||
    typeof lat2 !== 'number' ||
    typeof lng2 !== 'number'
  ) {
    return null;
  }
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

/* ─────────────────────────────────────────────
 * GET /api/locations/nearby
 *
 * Query:
 *   lat, lng      (optional) guest coordinates
 *   radiusKm      (optional) radius in km, default 5
 *   radius        (optional) legacy radius in meters -> converted to km
 *
 * Returns:
 *   { locations: [ { id, name, address, price, rating, photoUrl,
 *                    coordinates, distanceKm, ... } ] }
 *
 * Works with coordinates stored as:
 *   - GeoPoint (coordinates.latitude / coordinates.longitude)
 *   - { lat, lng } plain object
 * ────────────────────────────────────────────*/
router.get(
  '/nearby',
  [
    query('lat').optional().isFloat({ min: -90, max: 90 }),
    query('lng').optional().isFloat({ min: -180, max: 180 }),
    query('radiusKm').optional().isFloat({ min: 0.1, max: 50 }),
    query('radius').optional().isInt({ min: 100, max: 100000 }), // meters (legacy)
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const lat = req.query.lat != null ? Number(req.query.lat) : null;
      const lng = req.query.lng != null ? Number(req.query.lng) : null;

      // Prefer radiusKm, fall back to radius (meters) or default 5km
      let radiusKm = 5;
      if (req.query.radiusKm != null) {
        radiusKm = Number(req.query.radiusKm);
      } else if (req.query.radius != null) {
        radiusKm = Number(req.query.radius) / 1000;
      }

      // Pull up to 200 active locations
      const snap = await locationsCol.where('isActive', '==', true).limit(200).get();

      const locations = [];
      snap.forEach((doc) => {
        const d = doc.data() || {};
        const coords = d.coordinates;

        // Support GeoPoint and { lat, lng }
        let locLat = null;
        let locLng = null;
        if (coords) {
          // GeoPoint or GeoPoint-like { latitude, longitude }
          if (
            typeof coords.latitude === 'number' &&
            typeof coords.longitude === 'number'
          ) {
            locLat = coords.latitude;
            locLng = coords.longitude;
          } else if (
            typeof coords.lat === 'number' &&
            typeof coords.lng === 'number'
          ) {
            locLat = coords.lat;
            locLng = coords.lng;
          }
        }

        let distanceKm = null;
        if (lat != null && lng != null && locLat != null && locLng != null) {
          distanceKm = haversineKm(lat, lng, locLat, locLng);
        }

        // If we have guest coords and radius, filter by radius
        if (distanceKm != null && distanceKm > radiusKm) {
          return; // skip this doc
        }

        locations.push({
          id: doc.id,
          name: d.name || d.address || '',
          address: d.address || '',
          price:
            d.price != null
              ? Number(d.price)
              : d.pricing?.basePrice != null
              ? Number(d.pricing.basePrice)
              : null,
          rating:
            d.rating != null
              ? Number(d.rating)
              : d.rating?.average != null
              ? Number(d.rating.average)
              : null,
          totalReviews: d.totalReviews || d.rating?.count || 0,
          photoUrl:
            d.photoUrl ||
            (Array.isArray(d.photos) && d.photos.length > 0
              ? d.photos[0].url || d.photos[0]
              : ''),
          accessCode: d.accessCode || '',
          instructions: d.instructions || d.instructionsPreview || '',
          coordinates: coords || null,
          isActive: d.isActive !== false,
          distanceKm,
        });
      });

      // Sort by distance if we know guest coords
      if (lat != null && lng != null) {
        locations.sort((a, b) => {
          const da = typeof a.distanceKm === 'number' ? a.distanceKm : 999999;
          const db = typeof b.distanceKm === 'number' ? b.distanceKm : 999999;
          return da - db;
        });
      }

      return res.json({ locations });
    } catch (err) {
      console.error('Nearby locations error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ─────────────────────────────────────────────
 * Partner-facing routes (legacy + still useful)
 * ────────────────────────────────────────────*/

/**
 * GET /api/locations/me (partner)
 */
router.get('/me', protect, async (req, res) => {
  try {
    const snap = await locationsCol
      .where('owner', '==', req.user.userId)
      .limit(1)
      .get();

    if (snap.empty) return res.status(404).json({ error: 'Location not found' });

    res.json({ id: snap.docs[0].id, ...snap.docs[0].data() });
  } catch (e) {
    console.error('Get location error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/locations/me (partner)
 * Legacy path that uses GeoFire + coordinates.latitude/longitude
 */
router.put(
  '/me',
  protect,
  [
    body('address').not().isEmpty().withMessage('Address is required'),
    body('coordinates.latitude').isFloat({ min: -90, max: 90 }),
    body('coordinates.longitude').isFloat({ min: -180, max: 180 }),
    body('pricing.basePrice').isFloat({ min: 0 }),
    body('pricing.surgeMultiplier').optional().isFloat({ min: 1 }),
    body('isPublic').optional().isBoolean(),
    body('isActive').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const {
        address,
        coordinates,
        pricing,
        amenities = [],
        isPublic = false,
        isActive = false,
      } = req.body;

      const geohash = geofire.geohashForLocation([
        coordinates.latitude,
        coordinates.longitude,
      ]);

      const snap = await locationsCol
        .where('owner', '==', req.user.userId)
        .limit(1)
        .get();

      const payload = {
        owner: req.user.userId,
        address,
        coordinates, // this will be an object {latitude, longitude}
        pricing: {
          basePrice: pricing.basePrice,
          surgeMultiplier: pricing.surgeMultiplier || 1,
        },
        amenities,
        isPublic,
        isActive,
        geohash,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

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
      console.error('Update location error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * POST /api/locations/me/photos (partner)
 */
router.post('/me/photos', protect, [body('url').isURL()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const snap = await locationsCol
      .where('owner', '==', req.user.userId)
      .limit(1)
      .get();
    if (snap.empty) return res.status(404).json({ error: 'Location not found' });

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
    console.error('Add photo error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/locations/me/status (partner)
 */
router.put(
  '/me/status',
  protect,
  [body('isActive').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const snap = await locationsCol
        .where('owner', '==', req.user.userId)
        .limit(1)
        .get();
      if (snap.empty) return res.status(404).json({ error: 'Location not found' });

      const ref = snap.docs[0].ref;
      await ref.set({ isActive: req.body.isActive }, { merge: true });
      const updated = await ref.get();
      res.json({ id: ref.id, ...updated.data() });
    } catch (e) {
      console.error('Update status error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
