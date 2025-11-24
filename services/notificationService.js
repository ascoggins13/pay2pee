// services/notificationService.js
const { admin, firestore } = require('../firebase-admin');

const notificationsCol = firestore.collection('notifications');

async function createNotification({
  userId,
  userType,
  type,
  title,
  body,
  data = null,
}) {
  if (!userId) return;

  await notificationsCol.add({
    userId,
    userType: userType || null,
    type,
    title,
    body,
    data,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = {
  createNotification,
};
