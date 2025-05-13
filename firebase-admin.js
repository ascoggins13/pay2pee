const admin = require('firebase-admin');

const serviceAccount = require('./serviceAccountKey.json'); // Download from Firebase

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'p2p-storage.appspot.com' // Replace with your bucket name
});

const bucket = admin.storage().bucket();
module.exports = { bucket };