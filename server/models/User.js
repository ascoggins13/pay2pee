// server/models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  authProvider: { type: String, enum: ['email', 'google', 'apple'] },
  subscription: {
    type: { type: String, enum: ['one-time', '24-hour', 'weekly', 'monthly', 'annual'] },
    expiresAt: Date,
    autoRenew: Boolean
  },
  paymentMethods: [{
    provider: String,
    lastFour: String
  }],
  ratingsGiven: [{
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    rating: Number,
    comment: String,
    date: { type: Date, default: Date.now }
  }]
});

module.exports = mongoose.model('User', UserSchema);