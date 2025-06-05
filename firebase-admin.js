const admin = require('firebase-admin');
<<<<<<< HEAD

const serviceAccount = require('./serviceAccountKey.json'); // Download from Firebase

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'p2p-storage.appspot.com' // Replace with your bucket name
});

const bucket = admin.storage().bucket();
module.exports = { bucket };
=======
const serviceAccount = require('./service-account-key.json'); // Download from Firebase Console

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'p2p-app.appspot.com' // Your bucket name
});

module.exports = {
  bucket: admin.storage().bucket()
};
>>>>>>> 64a0488 (Initial commit)
