// server/controllers/locations.js
exports.submitRating = async (req, res) => {
    const { locationId, rating, comment } = req.body;
   
    // Save rating
    const newRating = new Rating({
      user: req.user._id,
      location: locationId,
      rating,
      comment
    });
    await newRating.save();
   
    // Update location's average rating
    const location = await Location.findById(locationId);
    const allRatings = await Rating.find({ location: locationId });
   
    const total = allRatings.reduce((sum, r) => sum + r.rating, 0);
    location.rating.average = total / allRatings.length;
    location.rating.count = allRatings.length;
    await location.save();
   
    res.json({ success: true });
  };