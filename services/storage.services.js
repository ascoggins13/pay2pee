// services/storage.service.js
const { bucket } = require('../firebase-admin');

module.exports = {
  async uploadBathroomImage(fileBuffer, fileName, contentType = 'image/jpeg') {
    const file = bucket.file(`bathrooms/${fileName}`);
    await file.save(fileBuffer, { metadata: { contentType }, resumable: false });
    await file.makePublic();
    return file.publicUrl();
  },

  uploadBathroomImage: async (fileBuffer, fileName, contentType = 'image/jpeg') => {
    try {
      const file = bucket.file(`bathrooms/${fileName}`);
      
      await file.save(fileBuffer, {
        metadata: {
          contentType,
        },
        resumable: false,
      });

      await file.makePublic(); // Make accessible publicly
      return file.publicUrl();
    } catch (err) {
      console.error('🔥 Firebase upload error:', err);
      throw new Error('Image upload to Firebase failed');
    }
  },

  // Future methods can be added here
  // deleteBathroomImage: async (fileName) => { ... }
};
