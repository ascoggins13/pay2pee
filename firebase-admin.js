// firebase-admin.js
const admin = require("firebase-admin");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error(
    "FIREBASE_SERVICE_ACCOUNT env var is missing. Set it in Render -> Environment."
  );
}

let serviceJson;
try {
  serviceJson = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error("[firebase-admin] Failed to parse FIREBASE_SERVICE_ACCOUNT:", err);
  throw err; // hard fail so we don't run half-configured
}

// IMPORTANT: set projectId and storageBucket explicitly
const app = admin.initializeApp({
  credential: admin.credential.cert(serviceJson),
  projectId: serviceJson.project_id || "pay2pee-8af3d",
  storageBucket: "pay2pee-8af3d.appspot.com",
});

const firestore = admin.firestore();
const bucket = admin.storage().bucket();

function getFirebaseConfigInfo() {
  const opts = app.options || {};
  return {
    projectId: opts.projectId || null,
    storageBucket: opts.storageBucket || null,
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

