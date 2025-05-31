const express = require('express');
const { addBathroomImage } = require('../controllers/locations.controller');
const multer = require('multer');
const upload = multer(); // For handling multipart/form-data

const router = express.Router();

// Fixed route - with proper spacing and clear parameter
router.post(
  '/bathrooms/:id/images', // Explicit parameter name
  upload.single('image'), // Proper middleware formatting
  addBathroomImage // Handler function
);

module.exports = router;

