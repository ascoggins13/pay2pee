// locationRoutes.js
const express = require('express');
const auth = require('../middleware/auth');
const Location = require('../models/Location');
const router = express.Router();

// Get active locations for HomeScreen
router.get('/active', async (req, res) => {
  try {
    const locations = await Location.find({ isActive: true });
    res.json(locations);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching locations' });
  }
});

// Get/update partner's location
router.route('/me')
  .get(auth, async (req, res) => {
    try {
      const location = await Location.findOne({ owner: req.user.userId });
      res.json(location || {});
    } catch (error) {
      res.status(500).json({ message: 'Error fetching location' });
    }
  })
  .put(auth, async (req, res) => {
    try {
      const { name, address, description, photoUrls, coordinates, isActive } = req.body;
      
      let location = await Location.findOne({ owner: req.user.userId });
      
      if (location) {
        // Update existing
        location.name = name;
        location.address = address;
        location.description = description;
        location.photoUrls = photoUrls;
        location.coordinates = coordinates;
        location.isActive = isActive;
      } else {
        // Create new
        location = new Location({
          owner: req.user.userId,
          name,
          address,
          description,
          photoUrls,
          coordinates,
          isActive
        });
      }
      
      await location.save();
      res.json(location);
    } catch (error) {
      res.status(500).json({ message: 'Error saving location' });
    }
  });

// Update visibility only
router.put('/me/visibility', auth, async (req, res) => {
  try {
    const { isActive } = req.body;
    
    const location = await Location.findOneAndUpdate(
      { owner: req.user.userId },
      { isActive },
      { new: true, upsert: true }
    );
    
    res.json(location);
  } catch (error) {
    res.status(500).json({ message: 'Error updating visibility' });
  }
});

module.exports = router;

