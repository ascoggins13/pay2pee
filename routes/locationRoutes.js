const express = require('express');
const router = express.Router();
const Location = require('../models/Location');
const { protect } = require('../middleware/auth');
const { check, body, query, validationResult } = require('express-validator');
const admin = require('firebase-admin');

/**
 * @route GET /api/locations/nearby
 * @desc Get active locations near coordinates
 * @access Public
 * @query {lat} Latitude
 * @query {lng} Longitude
 * @query {radius} Search radius in meters (default: 1000)
 */
router.get('/nearby', [
  query('lat', 'Latitude must be between -90 and 90').isFloat({ min: -90, max: 90 }),
  query('lng', 'Longitude must be between -180 and 180').isFloat({ min: -180, max: 180 }),
  query('radius', 'Radius must be between 100-10000 meters')
    .optional()
    .isInt({ min: 100, max: 10000 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { lat, lng, radius = 1000 } = req.query;
    const maxDistance = parseInt(radius);

    const locations = await Location.find({
      isActive: true,
      coordinates: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [parseFloat(lng), parseFloat(lat)]
          },
          $maxDistance: maxDistance
        }
      }
    });

    res.json(locations);
  } catch (err) {
    console.error('Nearby locations error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route GET /api/locations/me
 * @desc Get current partner's location
 * @access Private (Partner)
 */
router.get('/me', protect, async (req, res) => {
  try {
    const location = await Location.findOne({ owner: req.user.id });
    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }
    res.json(location);
  } catch (err) {
    console.error('Get location error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route PUT /api/locations/me
 * @desc Create or update partner location
 * @access Private (Partner)
 * @body {address, coordinates, pricing, amenities, isPublic, isActive}
 */
router.put('/me', protect, [
  body('address', 'Address is required').not().isEmpty(),
  body('coordinates.latitude', 'Valid latitude (-90 to 90) required')
    .isFloat({ min: -90, max: 90 }),
  body('coordinates.longitude', 'Valid longitude (-180 to 180) required')
    .isFloat({ min: -180, max: 180 }),
  body('pricing.basePrice', 'Base price must be a positive number')
    .isFloat({ min: 0 }),
  body('pricing.surgeMultiplier', 'Surge multiplier must be at least 1')
    .optional()
    .isFloat({ min: 1 }),
  body('isPublic', 'Public status must be boolean').optional().isBoolean(),
  body('isActive', 'Active status must be boolean').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const locationFields = {
    owner: req.user.id,
    address: req.body.address,
    coordinates: {
      latitude: req.body.coordinates.latitude,
      longitude: req.body.coordinates.longitude
    },
    pricing: {
      basePrice: req.body.pricing.basePrice,
      surgeMultiplier: req.body.pricing.surgeMultiplier || 1.0
    },
    amenities: req.body.amenities || [],
    isPublic: req.body.isPublic || false,
    isActive: req.body.isActive || false
  };

  try {
    let location = await Location.findOne({ owner: req.user.id });

    if (location) {
      location = await Location.findOneAndUpdate(
        { owner: req.user.id },
        { $set: locationFields },
        { new: true }
      );
      return res.json(location);
    }

    location = new Location(locationFields);
    await location.save();
    res.status(201).json(location);
  } catch (err) {
    console.error('Update location error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route POST /api/locations/me/photos
 * @desc Add photo to location
 * @access Private (Partner)
 * @body {url} Firebase Storage URL
 */
router.post('/me/photos', protect, [
  body('url', 'Valid URL is required').isURL()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const location = await Location.findOne({ owner: req.user.id });
    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    location.photos.push({
      url: req.body.url,
      uploadedAt: new Date()
    });

    await location.save();
    res.json(location.photos);
  } catch (err) {
    console.error('Add photo error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route PUT /api/locations/me/status
 * @desc Update location active status
 * @access Private (Partner)
 * @body {isActive} Boolean status
 */
router.put('/me/status', protect, [
  body('isActive', 'Status must be boolean').isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const location = await Location.findOneAndUpdate(
      { owner: req.user.id },
      { isActive: req.body.isActive },
      { new: true }
    );

    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    res.json(location);
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;