// firebase-admin.js (pin project & creds, explicit Firestore client)
const admin = require('firebase-admin');
const { Firestore } = require('@google-cloud/firestore');

function getServiceAccount() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing.');
  }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is missing required fields (project_id, client_email, private_key).');
  }
  return sa;
}

let app, firestore, bucket;
if (!admin.apps.length) {
  const sa = getServiceAccount();
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    sa.project_id;

  app = admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`,
  });

  // Use explicit Firestore client (removes ambiguity):
  firestore = new Firestore({
    projectId,
    credentials: {
      client_email: sa.client_email,
      private_key: sa.private_key,
    },
  });

  bucket = admin.storage().bucket();
} else {
  app = admin.app();
  firestore = admin.firestore();
  bucket = admin.storage().bucket();
}

module.exports = { admin, firestore, bucket };
