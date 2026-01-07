// firebase-admin.js
const admin = require("firebase-admin");

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;

  const sa = JSON.parse(raw);

  // Render commonly stores newlines as \\n
  if (sa.private_key) {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }

  return sa;
}

if (!admin.apps.length) {
  const serviceAccount = loadServiceAccount();

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket:
        process.env.FIREBASE_STORAGE_BUCKET ||
        `${serviceAccount.project_id}.appspot.com`,
    });
  } else {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT missing – using default credentials.");
    admin.initializeApp();
  }
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = { admin, db, bucket };