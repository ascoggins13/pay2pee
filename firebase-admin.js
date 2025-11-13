// firebase-admin.js
const admin = require("firebase-admin");

let app;

// Try to use FIREBASE_SERVICE_ACCOUNT from env (JSON)
if (!admin.apps.length) {
  let opts = {};

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

      opts = {
        credential: admin.credential.cert(sa),
        // This MUST match your real bucket:
        storageBucket: "pay2pee-8af3d.appspot.com",
      };

      console.log("[firebase-admin] Initialized with FIREBASE_SERVICE_ACCOUNT for project:", sa.project_id);
    } catch (err) {
      console.error("[firebase-admin] Failed to parse FIREBASE_SERVICE_ACCOUNT:", err);
      // Fallback: applicationDefault (only works if Render has GCP creds mounted)
      opts = {
        credential: admin.credential.applicationDefault(),
        storageBucket: "pay2pee-8af3d.appspot.com",
      };
      console.log("[firebase-admin] Falling back to applicationDefault credentials.");
    }
  } else {
    // No explicit service account JSON, rely on application default
    opts = {
      credential: admin.credential.applicationDefault(),
      storageBucket: "pay2pee-8af3d.appspot.com",
    };
    console.log("[firebase-admin] Initialized with applicationDefault credentials.");
  }

  app = admin.initializeApp(opts);
} else {
  app = admin.app();
}

const firestore = admin.firestore();
const bucket = admin.storage().bucket();

/**
 * Small helpers for debug endpoints
 */
function getFirebaseConfigInfo() {
  const options = app.options || {};
  return {
    projectId: options.projectId || null,
    storageBucket: options.storageBucket || null,
  };
}

async function firestoreSmokeTest() {
  const ref = firestore.collection("_debug").doc("smoketest");
  await ref.set(
    {
      ping: "ok",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const snap = await ref.get();
  return {
    exists: snap.exists,
    data: snap.data() || null,
  };
}

module.exports = {
  admin,
  firestore,
  bucket,
  getFirebaseConfigInfo,
  firestoreSmokeTest,
};
