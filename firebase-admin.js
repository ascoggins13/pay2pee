// firebase-admin.js — singleton init (CommonJS)
const admin = require('firebase-admin');

function getServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    // Normalize escaped newlines in the private key if needed
    if (json.private_key && json.private_key.includes('\\n')) {
      json.private_key = json.private_key.replace(/\\n/g, '\n');
    }
    return json;
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', e.message);
    return null;
  }
}

if (!admin.apps.length) {
  const sa = getServiceAccountFromEnv();
  if (sa) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // e.g. pay2pee-xxxx.appspot.com
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  } else {
    // Last-resort local fallback (emulators)
    admin.initializeApp();
  }
}

const firestore = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = { admin, firestore, bucket };
