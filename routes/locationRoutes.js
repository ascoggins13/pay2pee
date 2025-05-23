const express = require('express');
const router = express.Router();
const Location = require('../models/Location');
const auth = require('../middleware/auth');
const { check, validationResult } = require('express-validator');
const admin = require('firebase-admin');

// Initialize Firebase if not already done
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require('../path/to/firebase-admin-sdk.json')),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
}

// @route GET /api/locations/nearby
// @desc Get active locations near coordinates
// @access Public
router.get('/nearby', [
  check('lat', 'Latitude is required').isFloat({ min: -90, max: 90 }),
  check('lng', 'Longitude is required').isFloat({ min: -180, max: 180 }),
  check('radius', 'Radius must be a number').optional().isInt({ min: 100, max: 10000 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { lat, lng, radius = 1000 } = req.query;
    const maxDistance = parseInt(radius);

    // Simple bounding box calculation for initial filtering
    const locations = await Location.find({
      'isActive': true,
      'coordinates.latitude': {
        $gte: parseFloat(lat) - 0.01,
        $lte: parseFloat(lat) + 0.01
      },
      'coordinates.longitude': {
        $gte: parseFloat(lng) - 0.01,
        $lte: parseFloat(lng) + 0.01
      }
    });

    // Haversine formula for accurate distance calculation
    const filteredLocations = locations.filter(loc => {
      const R = 6371000; // Earth radius in meters
      const φ1 = lat * Math.PI/180;
      const φ2 = loc.coordinates.latitude * Math.PI/180;
      const Δφ = (loc.coordinates.latitude-lat) * Math.PI/180;
      const Δλ = (loc.coordinates.longitude-lng) * Math.PI/180;

      const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

      return (R * c) <= maxDistance;
    });

    res.json(filteredLocations);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route GET /api/locations/me
// @desc Get current partner's location
// @access Private (Partner)
router.get('/me', auth, async (req, res) => {
  try {
    const location = await Location.findOne({ owner: req.user.id });
    if (!location) {
      return res.status(404).json({ msg: 'Location not found' });
    }
    res.json(location);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route PUT /api/locations/me
// @desc Create or update partner location
// @access Private (Partner)
router.put('/me', auth, [
  check('address', 'Address is required').not().isEmpty(),
  check('coordinates.latitude', 'Valid latitude is required').isFloat({ min: -90, max: 90 }),
  check('coordinates.longitude', 'Valid longitude is required').isFloat({ min: -180, max: 180 }),
  check('pricing.basePrice', 'Base price is required').isFloat({ min: 0 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const locationFields = {
    owner: req.user.id,
    address: req.body.address,
    coordinates: req.body.coordinates,
    pricing: {
      basePrice: req.body.pricing.basePrice,
      surgeMultiplier: req.body.pricing.surgeMultiplier || 1
    },
    amenities: req.body.amenities || [],
    isPublic: req.body.isPublic || false,
    isActive: req.body.isActive || false
  };

  try {
    let location = await Location.findOne({ owner: req.user.id });

    if (location) {
      // Update existing location
      location = await Location.findOneAndUpdate(
        { owner: req.user.id },
        { $set: locationFields },
        { new: true }
      );
      return res.json(location);
    }

    // Create new location
    location = new Location(locationFields);
    await location.save();
    res.json(location);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route POST /api/locations/me/photos
// @desc Add photo to location
// @access Private (Partner)
router.post('/me/photos', auth, async (req, res) => {
  try {
    const location = await Location.findOne({ owner: req.user.id });
    if (!location) {
      return res.status(404).json({ msg: 'Location not found' });
    }

    // In practice, you would upload the file to Firebase Storage first
    // Then add the download URL to the location
    const newPhoto = {
      url: req.body.url, // Should be Firebase Storage URL
      uploadedAt: new Date()
    };

    location.photos.push(newPhoto);
    await location.save();

    res.json(location.photos);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route PUT /api/locations/me/status
// @desc Update location visibility status
// @access Private (Partner)
router.put('/me/status', auth, [
  check('isActive', 'Status is required').isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const location = await Location.findOneAndUpdate(
      { owner: req.user.id },
      { $set: { isActive: req.body.isActive } },
      { new: true }
    );

    if (!location) {
      return res.status(404).json({ msg: 'Location not found' });
    }

    res.json(location);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;