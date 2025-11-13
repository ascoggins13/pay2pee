// firebase-admin.js
require('dotenv').config();

const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

// ---- Load service account JSON from env ----
let serviceAccount = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', e.message);
  }
}

const projectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  (serviceAccount && serviceAccount.project_id);

const databaseId = process.env.FIRESTORE_DATABASE_ID || 'payouts'; // ⬅️ default to payouts
const storageBucket =
  process.env.FIREBASE_STORAGE_BUCKET ||
  `${projectId}.appspot.com`;

// ---- Initialize app ----
let app;
if (!admin.apps.length) {
  if (serviceAccount) {
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
      storageBucket,
    });
  } else {
    // fallback, but you *should* be using FIREBASE_SERVICE_ACCOUNT in prod
    app = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
      storageBucket,
    });
  }
} else {
  app = admin.app();
}

// Use the *payouts* database
const firestore = getFirestore(app, databaseId);
// Storage
const bucket = getStorage(app).bucket();

// ---- Debug helpers (used by /api/_debug routes) ----
function getFirebaseConfigInfo() {
  return {
    projectId: firestore.projectId || projectId || null,
    databaseId,
    storageBucket,
    from: serviceAccount ? 'SERVICE_ACCOUNT' : 'APPLICATION_DEFAULT',
  };
}

async function firestoreSmokeTest() {
  try {
    // just try to read from the special root list of collections
    const collections = await firestore.listCollections();
    return { ok: true, count: collections.length };
  } catch (err) {
    console.error('firestoreSmokeTest error:', err);
    return {
      ok: false,
      code: err.code,
      message: String(err.message || err),
    };
  }
}

module.exports = {
  admin,
  firestore,
  bucket,
  getFirebaseConfigInfo,
  firestoreSmokeTest,
};
