// server/models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required']
  },
  email: {
    type: String,
    unique: true,
    required: [true, 'Email is required'],
    match: [/^\S+@\S+\.\S+$/, 'Invalid email format']
  },
  password: {  // Added for email-based auth
    type: String,
    select: false,  // Never return password in queries
    minlength: 8
  },
  authProvider: {
    type: String,
    enum: ['email', 'google', 'apple'],
    required: true
  },
  userType: {  // Critical for routing (user/partner)
    type: String,
    enum: ['user', 'partner'],
    default: 'user'
  },
  subscription: {
    type: {
      type: String,
      enum: ['one-time', '24-hour', 'weekly', 'monthly', 'annual']
    },
    expiresAt: Date,
    autoRenew: Boolean
  },
  paymentMethods: [{
    provider: String,
    lastFour: String,
    isDefault: Boolean
  }],
  ratingsGiven: [{
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    comment: String,
    date: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// Password hashing (for email auth)
UserSchema.pre('save', async function(next) {
  if (this.authProvider !== 'email' || !this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

module.exports = mongoose.model('User', UserSchema);