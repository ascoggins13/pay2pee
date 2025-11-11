// server/routes/subscriptions.js
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.send('Subscription route placeholder');
});

module.exports = router;