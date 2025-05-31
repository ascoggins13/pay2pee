const express = require('express');
const { addBathroomImage } = require('../controllers/locations.controller');
const multer = require('multer');
const upload = multer(); // For handling multipart/form-data

const router = express.Router();

// Correct route: will map to /api/bathrooms/:id/images
router.post('/:id/images', upload.single('image'), addBathroomImage);

module.exports = router;
