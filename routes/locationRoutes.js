// routes/locationRoutes.js (Firestore)
const express = require('express');
const { query, body, validationResult } = require('express-validator');
const geofire = require('geofire-common');
const { admin, firestore } = require('../firebase-admin'); // path from that file
const protect = require('../middleware/protect'); // your JWT middleware

const router = express.Router();
const locationsCol = firestore.collection('locations');

/**
 * GET /api/locations/nearby?lat=&lng=&radius=
 */
router.get(
  '/nearby',
  [
    query('lat').isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
    query('lng').isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
    query('radius').optional().isInt({ min: 100, max: 10000 }).withMessage('Radius 100–10000 (meters)'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const lat = parseFloat(req.query.lat);
      const lng = parseFloat(req.query.lng);
      const radiusM = parseInt(req.query.radius || '1000', 10);

      // geohash bounds
      const radiusKm = radiusM / 1000;
      const center = [lat, lng];
      const bounds = geofire.geohashQueryBounds(center, radiusKm);
      const promises = bounds.map(([start, end]) =>
        locationsCol
          .orderBy('geohash')
          .startAt(start)
          .endAt(end)
          .get()
      );

      const snapshots = await Promise.all(promises);
      const candidates = [];
      snapshots.forEach(snap =>
        snap.forEach(doc => {
          const d = doc.data();
          if (d.isActive) {
            const distance = geofire.distanceBetween(center, [d.coordinates.latitude, d.coordinates.longitude]) * 1000;
            if (distance <= radiusM) {
              candidates.push({
                id: doc.id,
                name: d.name || d.address,
                address: d.address,
                lat: d.coordinates.latitude,
                lng: d.coordinates.longitude,
                price: d.pricing?.basePrice ?? 0,
                rating: d.rating?.average ?? 4.8,
                review_count: d.rating?.count ?? 0,
                cleanliness: d.cleanliness || 'A',
                is_open: d.isActive,
                features: d.amenities || [],
                image_url: d.photos?.[0]?.url || '',
                distance_text: `${Math.round(distance)} m`,
                instructions_preview: d.instructionsPreview || '',
              });
            }
          }
        })
      );

      // sort by distance
      candidates.sort((a, b) => parseInt(a.distance_text) - parseInt(b.distance_text));
      res.json({ locations: candidates });
    } catch (err) {
      console.error('Nearby locations error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * GET /api/locations/me (partner)
 */
router.get('/me', protect, async (req, res) => {
  try {
    const snap = await locationsCol.where('owner', '==', req.user.userId).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Location not found' });
    res.json({ id: snap.docs[0].id, ...snap.docs[0].data() });
  } catch (e) {
    console.error('Get location error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/locations/me (partner)
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

      // compute geohash
      const geohash = geofire.geohashForLocation([coordinates.latitude, coordinates.longitude]);

      // find or create by owner
      const snap = await locationsCol.where('owner', '==', req.user.userId).limit(1).get();
      const payload = {
        owner: req.user.userId,
        address,
        coordinates,
        pricing: { basePrice: pricing.basePrice, surgeMultiplier: pricing.surgeMultiplier || 1 },
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
    const snap = await locationsCol.where('owner', '==', req.user.userId).limit(1).get();
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
router.put('/me/status', protect, [body('isActive').isBoolean()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const snap = await locationsCol.where('owner', '==', req.user.userId).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Location not found' });

    const ref = snap.docs[0].ref;
    await ref.set({ isActive: req.body.isActive }, { merge: true });
    const updated = await ref.get();
    res.json({ id: ref.id, ...updated.data() });
  } catch (e) {
    console.error('Update status error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;