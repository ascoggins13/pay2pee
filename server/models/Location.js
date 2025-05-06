// server/models/Location.js
const mongoose = require('mongoose');

const LocationSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  address: String,
  coordinates: {
    latitude: Number,
    longitude: Number
  },
  isPublic: Boolean,
  isActive: Boolean,
  photos: [String],
  amenities: [String], // e.g., ['bidet', 'changing table', 'shower']
  rating: {
    average: { type: Number, default: 0 },
    count: { type: Number, default: 0 }
  },
  pricing: {
    basePrice: Number,
    surgeMultiplier: { type: Number, default: 1 }
  },
  currentVisitors: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    checkIn: { type: Date, default: Date.now }
  }],
  earnings: [{
    date: Date,
    amount: Number,
    visits: Number
  }]
});

module.exports = mongoose.model('Location', LocationSchema);

