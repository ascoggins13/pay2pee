const express = require('express');
const multer = require('multer');
const { addBathroomImage } = require('../controllers/locations.controller');

const upload = multer();
const router = express.Router();

router.post('/:id/images', upload.single('image'), addBathroomImage);

module.exports = router;