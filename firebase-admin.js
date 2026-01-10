// firebase-admin.js
// One place to initialize Firebase Admin cleanly for Render/Node.

const admin = require('firebase-admin');

function parseServiceAccount() {
  // Preferred: put your service account JSON (one-line) in FIREBASE_SERVICE_ACCOUNT
  // Fallbacks: GOOGLE_APPLICATION_CREDENTIALS (path) or applicationDefault()
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    } catch (e) {
      console.error('❌ Failed to JSON.parse(FIREBASE_SERVICE_ACCOUNT):', e.message);
      throw e;
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.credential.applicationDefault();
  }
  return admin.credential.applicationDefault();
}

if (!admin.apps.length) {
  const credential = parseServiceAccount();

  // Pick projectId and storage bucket smartly
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    (process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT).project_id
      : undefined);

  // IMPORTANT: Firestore uses PROJECT.appspot.com buckets for Admin SDK
  const defaultBucket =
    process.env.FIREBASE_STORAGE_BUCKET ||
    (projectId ? `${projectId}.appspot.com` : undefined);

  admin.initializeApp({
    credential,
    projectId,
    storageBucket: defaultBucket,
  });
}

const firestore = admin.firestore();
const bucket = admin.storage().bucket();

// Small helpers for debugging
function resolvedInfo() {
  const app = admin.app();
  return {
    resolvedProjectId:
      app.options.projectId ||
      (process.env.FIREBASE_SERVICE_ACCOUNT
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT).project_id
        : undefined),
    storageBucket: app.options.storageBucket,
  };
}

module.exports = { admin, firestore, bucket, resolvedInfo };
