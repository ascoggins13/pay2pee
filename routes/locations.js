const express = require('express');
const { addBathroomImage } = require('../controllers/locations.controller');
const multer = require('multer');
const upload = multer(); // For handling multipart/form-data

const router = express.Router();
router.post('/bathrooms/:id/images', upload.single('image'), addBathroomImage);
