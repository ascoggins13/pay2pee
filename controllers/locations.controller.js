exports.addBathroomImage = async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = file.buffer;
    const fileName = `${Date.now()}_${file.originalname}`;

    const imageUrl = await storageService.uploadBathroomImage(fileBuffer, fileName);
    
    res.status(200).json({ imageUrl });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
};

