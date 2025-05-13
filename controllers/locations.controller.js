const storageService = require('../services/storage.service');

exports.addBathroomImage = async (req, res) => {
  try {
    const { fileBuffer, fileName } = req; // From middleware (e.g., multer)
    const imageUrl = await storageService.uploadBathroomImage(fileBuffer, fileName);
    
    res.status(200).json({ imageUrl });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' });
  }
};
