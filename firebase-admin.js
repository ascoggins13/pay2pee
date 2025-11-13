// firebase-admin.js
// Centralized Firebase Admin + Firestore config for Pay2Pee

const admin = require('firebase-admin');
const { Firestore } = require('@google-cloud/firestore');

let serviceAccount = null;

// Read service account JSON from env (ONE-LINE JSON STRING)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:', err.message || err);
  }
}

// Initialize Firebase Admin (auth + storage)
if (!admin.apps.length) {
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
      storageBucket:
        process.env.FIREBASE_STORAGE_BUCKET ||
        `${serviceAccount.project_id}.appspot.com`,
    });
  } else {
    console.warn(
      '⚠️ FIREBASE_SERVICE_ACCOUNT not set or invalid – using default credentials.'
    );
    admin.initializeApp();
  }
}

// Figure out project + db info
const projectId =
  serviceAccount?.project_id ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  null;

// IMPORTANT: your Firestore database id is **payouts**
const databaseId = process.env.FIRESTORE_DATABASE_ID || 'payouts';

// Firestore instance (explicit databaseId so we don’t hit (default))
let firestore;
if (projectId && serviceAccount) {
  firestore = new Firestore({
    projectId,
    databaseId,
    credentials: {
      client_email: serviceAccount.client_email,
      private_key: serviceAccount.private_key,
    },
  });
} else {
  // Fallback – will default to (default) database
  console.warn(
    '⚠️ Using admin.firestore() fallback – databaseId may default to (default).'
  );
  firestore = admin.firestore();
}

// Storage bucket
const bucket = admin.storage().bucket();

/* ---------- Debug helpers ---------- */

function getFirebaseConfigInfo() {
  return {
    projectId: projectId,
    databaseId,
    storageBucket: admin.app().options.storageBucket || null,
    from: serviceAccount ? 'SERVICE_ACCOUNT' : 'DEFAULT',
  };
}

async function firestoreSmokeTest() {
  try {
    const cols = await firestore.listCollections();
    return { ok: true, count: cols.length };
  } catch (err) {
    console.error('🔥 firestoreSmokeTest error:', err);
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
