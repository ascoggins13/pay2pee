const express = require('express');
const paymentsController = require('../controllers/paymentsController');
const authMiddleware = require('../middlewares/auth');

const router = express.Router();

router.post(
  '/subscriptions',
  authMiddleware,
  paymentsController.createSubscription
);

module.exports = router;
