const admin = require('firebase-admin');
// firebase-admin.js
const admin = require('firebase-admin');

// Prefer GOOGLE_APPLICATION_CREDENTIALS (path) or FIREBASE_SERVICE_ACCOUNT (JSON string)
if (!admin.apps.length) {
  const hasServiceJson = !!process.env.FIREBASE_SERVICE_ACCOUNT;
  const hasDefaultCreds = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (hasServiceJson) {
    // When you paste the service account JSON into an env var
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // e.g. p2p-storage.appspot.com
    });
  } else if (hasDefaultCreds) {
    // When GOOGLE_APPLICATION_CREDENTIALS points to a JSON file path
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  } else {
    // Local fallback: allow emulator/default without creds file (only if you know what you're doing)
    admin.initializeApp();
  }
}

const firestore = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = { admin, firestore, bucket };
