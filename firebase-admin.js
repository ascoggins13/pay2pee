// server/firebase-admin.js
const admin = require("firebase-admin");
const { Firestore } = require("@google-cloud/firestore");

let serviceAccount = null;

// Parse service account (ONE LINE JSON string in env)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT parse failed:", err.message || err);
    serviceAccount = null; // don't crash module
  }
}

// Initialize Admin SDK (auth/storage/etc)
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
    // Will use Render/Google default credentials if available
    admin.initializeApp();
  }
}

// Resolve projectId safely
const projectId =
  serviceAccount?.project_id ||
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT;

// Your DB id
const databaseId = process.env.FIRESTORE_DATABASE_ID || "payouts";

// ✅ Firestore client pointing at the payouts DB
// If you have serviceAccount, pass explicit credentials.
// If not, let ADC handle it (but you still want projectId if possible).
let firestore;
try {
  if (serviceAccount) {
    firestore = new Firestore({
      projectId,
      databaseId,
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
      },
    });
  } else {
    firestore = new Firestore({
      projectId,
      databaseId,
    });
  }
} catch (e) {
  console.error("🔥 Firestore init failed:", e);
  // Last-resort fallback (may hit default DB, but avoids undefined crashes)
  firestore = admin.firestore();
}

const bucket = admin.storage().bucket();

module.exports = { admin, firestore, bucket };