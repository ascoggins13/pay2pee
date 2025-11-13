// firebase-admin.js
const admin = require('firebase-admin');

let app;
let cachedConfigInfo = null;

// Only initialize once
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:', err);
      throw err;
    }

    // Normalize the private key (fixes \n escaping from env)
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    const projectId = serviceAccount.project_id;
    const storageBucket =
      process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`;

    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
      storageBucket,
    });

    cachedConfigInfo = {
      projectId,
      storageBucket,
      from: 'SERVICE_ACCOUNT',
    };
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set, using applicationDefault()');

    const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || undefined;

    app = admin.initializeApp({
      storageBucket,
    });

    cachedConfigInfo = {
      projectId:
        process.env.GCLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        app?.options?.projectId ||
        null,
      storageBucket,
      from: 'APPLICATION_DEFAULT',
    };
  }
}

const firestore = admin.firestore();
const bucket = admin.storage().bucket();

/**
 * Debug helper for /api/_debug/fs-smoketest
 * Tries to read from the _meta collection.
 */
async function getFirestoreSmoketest() {
  try {
    const snap = await firestore.collection('_meta').limit(1).get();
    return {
      ok: true,
      count: snap.size,
    };
  } catch (err) {
    console.error('🔥 Firestore smoketest failed:', err);
    return {
      ok: false,
      code: err.code,
      message: err.message,
    };
  }
}

/**
 * Debug helper for /api/_debug/firebase
 * Returns projectId & storageBucket as seen by the SDK.
 */
function getFirebaseConfigInfo() {
  if (cachedConfigInfo) return cachedConfigInfo;

  return {
    projectId: app?.options?.projectId || null,
    storageBucket: app?.options?.storageBucket || null,
    from: 'APP_OPTIONS',
  };
}

module.exports = {
  admin,
  firestore,
  bucket,
  getFirestoreSmoketest,
  getFirebaseConfigInfo,
};
