// services/storage.service.js
const { bucket } = require('../firebase-admin');

module.exports = {
  /**
   * Uploads a bathroom image to Firebase Storage and returns its public URL.
   *
   * @param {Buffer} fileBuffer - The image buffer from multer
   * @param {string} fileName - Name to store the file as
   * @param {string} contentType - MIME type (e.g., image/jpeg, image/png)
   * @returns {Promise<string>} - Public URL of the uploaded image
   */
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
