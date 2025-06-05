// server/models/Location.js
const mongoose = require('mongoose');

const LocationSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  address: {
    type: String,
    required: [true, 'Address is required']
  },
  coordinates: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true }
  },
  isPublic: {
    type: Boolean,
    default: false
  },
  isActive: {  // Controls visibility on HomeScreen
    type: Boolean,
    default: false
  },
  photos: [{
    url: String,  // Firebase Storage URL
    uploadedAt: { type: Date, default: Date.now }
  }],
  amenities: {
    type: [String],
    enum: ['bidet', 'changing table', 'shower', 'handicap accessible', 'towels', 'mirror']
  },
  rating: {
    average: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    count: { type: Number, default: 0 }
  },
  pricing: {
    basePrice: {
      type: Number,
      required: true,
      min: 0
    },
    surgeMultiplier: {
      type: Number,
      default: 1,
      min: 1
    }
  },
  currentVisitors: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    checkIn: { type: Date, default: Date.now }
  }],
  earnings: [{
    date: { type: Date, default: Date.now },
    amount: { type: Number, required: true },
    visits: { type: Number, default: 1 }
  }]
}, { timestamps: true });

// Auto-update rating average when new reviews are added
LocationSchema.methods.updateRating = async function(rating) {
  this.rating.average = ((this.rating.average * this.rating.count) + rating) / (this.rating.count + 1);
  this.rating.count += 1;
  await this.save();
};

module.exports = mongoose.model('Location', LocationSchema);
