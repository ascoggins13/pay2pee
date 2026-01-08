// firebase-admin.js
// Centralized Firebase Admin + Firestore config for Pay2Pee

const admin = require("firebase-admin");

let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    // Fix common Render/ENV issue: private_key newlines
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:", err.message || err);
  }
}

if (!admin.apps.length) {
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket:
        process.env.FIREBASE_STORAGE_BUCKET ||
        `${serviceAccount.project_id}.appspot.com`,
    });
  } else {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT missing/invalid — using default credentials.");
    admin.initializeApp();
  }
}

// ✅ Always use Admin SDK Firestore instance for compatibility with your routes
const firestore = admin.firestore();

// Storage bucket (safe even if you don't use it everywhere)
const bucket = admin.storage().bucket();

function getFirebaseConfigInfo() {
  return {
    projectId: admin.app().options.projectId || serviceAccount?.project_id || null,
    storageBucket: admin.app().options.storageBucket || null,
    from: serviceAccount ? "SERVICE_ACCOUNT" : "DEFAULT",
  };
}

async function firestoreSmokeTest() {
  try {
    const cols = await firestore.listCollections();
    return { ok: true, count: cols.length };
  } catch (err) {
    console.error("🔥 firestoreSmokeTest error:", err);
    return { ok: false, message: String(err.message || err) };
  }
}

module.exports = {
  admin,
  firestore,
  bucket,
  getFirebaseConfigInfo,
  firestoreSmokeTest,
};