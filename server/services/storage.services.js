const { bucket } = require('../firebase-admin');

module.exports = {
  uploadBathroomImage: async (fileBuffer, fileName) => {
    const file = bucket.file(`bathrooms/${fileName}`);
    
    await file.save(fileBuffer, {
      metadata: {
        contentType: 'image/jpeg' // or 'image/png'
      }
    });
    
    await file.makePublic();
    return file.publicUrl();
  },

  // Add other storage methods here (e.g., deleteImage)
};