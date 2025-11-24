// routes/chatRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const protect = require('../middleware/protect');
const { admin, firestore } = require('../firebase-admin');
const { createNotification } = require('../services/notificationService');

const router = express.Router();

const chatsCol = firestore.collection('chats');
const guestVisitsCol = firestore.collection('guestVisits');
const locationsCol = firestore.collection('locations');

/**
 * POST /api/chat/start
 * Body: { guestVisitId: string }
 * Ensures a chat exists for a given guest visit and returns it.
 */
router.post(
  '/start',
  protect,
  [body('guestVisitId').notEmpty().withMessage('guestVisitId is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { guestVisitId } = req.body;
      const userId = req.user.id || req.user.userId;

      const visitRef = guestVisitsCol.doc(guestVisitId);
      const visitSnap = await visitRef.get();

      if (!visitSnap.exists) {
        return res.status(404).json({ error: 'Visit not found' });
      }

      const visit = visitSnap.data() || {};
      const guestId = visit.userId;
      const partnerId = visit.partnerId;
      const locationId = visit.locationId || null;

      if (!guestId || !partnerId) {
        return res
          .status(400)
          .json({ error: 'Visit is missing guest or partner info' });
      }

      if (userId !== guestId && userId !== partnerId) {
        return res
          .status(403)
          .json({ error: 'You are not part of this visit' });
      }

      // If a chat already exists for this visit, return it
      const existingSnap = await chatsCol
        .where('guestVisitId', '==', guestVisitId)
        .limit(1)
        .get();

      if (!existingSnap.empty) {
        const doc = existingSnap.docs[0];
        return res.json({ chat: { id: doc.id, ...doc.data() } });
      }

      // Otherwise create a new chat
      let locationName = 'Bathroom visit';
      if (locationId) {
        const locSnap = await locationsCol.doc(locationId).get();
        if (locSnap.exists) {
          const loc = locSnap.data() || {};
          if (loc.name) locationName = loc.name;
        }
      }

      const now = admin.firestore.Timestamp.now();

      const chatData = {
        guestVisitId,
        guestId,
        partnerId,
        locationId,
        locationName,
        lastMessageText: '',
        lastMessageAt: now,
        lastMessageSenderId: null,
        createdAt: now,
        updatedAt: now,
      };

      const chatRef = await chatsCol.add(chatData);
      return res.json({ chat: { id: chatRef.id, ...chatData } });
    } catch (err) {
      console.error('POST /chat/start error:', err);
      return res
        .status(500)
        .json({ error: err.message || 'Failed to start chat' });
    }
  }
);

/**
 * GET /api/chat
 * Lists all chats for the current user (guest or partner).
 */
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const userType = req.user.userType || null;

    let query;

    if (userType === 'partner') {
      query = chatsCol.where('partnerId', '==', userId);
    } else {
      // default to guest side
      query = chatsCol.where('guestId', '==', userId);
    }

    const snap = await query.orderBy('lastMessageAt', 'desc').limit(50).get();
    const chats = [];
    snap.forEach((doc) => {
      chats.push({ id: doc.id, ...doc.data() });
    });

    return res.json({ chats });
  } catch (err) {
    console.error('GET /chat error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to load chats' });
  }
});

/**
 * GET /api/chat/:chatId/messages
 * Returns messages for a single chat (ensuring the user is part of it).
 */
router.get('/:chatId/messages', protect, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id || req.user.userId;

    const chatRef = chatsCol.doc(chatId);
    const chatSnap = await chatRef.get();

    if (!chatSnap.exists) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const chat = chatSnap.data() || {};
    if (chat.guestId !== userId && chat.partnerId !== userId) {
      return res
        .status(403)
        .json({ error: 'You are not allowed to view this chat' });
    }

    const messagesSnap = await chatRef
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limit(200)
      .get();

    const messages = [];
    messagesSnap.forEach((doc) => {
      messages.push({ id: doc.id, ...doc.data() });
    });

    return res.json({ chat: { id: chatId, ...chat }, messages });
  } catch (err) {
    console.error('GET /chat/:chatId/messages error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to load messages' });
  }
});

/**
 * POST /api/chat/:chatId/messages
 * Body: { text: string }
 * Sends a message in an existing chat.
 */
router.post(
  '/:chatId/messages',
  protect,
  [body('text').notEmpty().withMessage('text is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { chatId } = req.params;
      const { text } = req.body;
      const userId = req.user.id || req.user.userId;

      const chatRef = chatsCol.doc(chatId);
      const chatSnap = await chatRef.get();

      if (!chatSnap.exists) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      const chat = chatSnap.data() || {};
      if (chat.guestId !== userId && chat.partnerId !== userId) {
        return res
          .status(403)
          .json({ error: 'You are not allowed to send messages in this chat' });
      }

      const senderType = chat.partnerId === userId ? 'partner' : 'guest';
      const now = admin.firestore.Timestamp.now();

      const messageData = {
        senderId: userId,
        senderType,
        text,
        createdAt: now,
        readByGuest: senderType === 'guest',
        readByPartner: senderType === 'partner',
      };

      const msgRef = await chatRef.collection('messages').add(messageData);

      await chatRef.set(
        {
          lastMessageText: text,
          lastMessageAt: now,
          lastMessageSenderId: userId,
          updatedAt: now,
        },
        { merge: true }
      );

      // Notify the other side
      const targetUserId =
        senderType === 'guest' ? chat.partnerId : chat.guestId;
      const targetType = senderType === 'guest' ? 'partner' : 'guest';

      if (targetUserId) {
        try {
          await createNotification({
            userId: targetUserId,
            userType: targetType,
            type:
              targetType === 'partner'
                ? 'PARTNER_CHAT_MESSAGE'
                : 'GUEST_CHAT_MESSAGE',
            title: 'New message',
            body: text.length > 80 ? `${text.slice(0, 77)}...` : text,
            data: {
              chatId,
              guestVisitId: chat.guestVisitId || null,
              locationId: chat.locationId || null,
            },
          });
        } catch (notifyErr) {
          console.error('Error creating chat notification:', notifyErr);
        }
      }

      return res.json({
        message: { id: msgRef.id, ...messageData },
      });
    } catch (err) {
      console.error('POST /chat/:chatId/messages error:', err);
      return res
        .status(500)
        .json({ error: err.message || 'Failed to send message' });
    }
  }
);

/**
 * POST /api/chat/:chatId/read
 * Marks messages as read for the current user.
 */
router.post('/:chatId/read', protect, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id || req.user.userId;

    const chatRef = chatsCol.doc(chatId);
    const chatSnap = await chatRef.get();

    if (!chatSnap.exists) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const chat = chatSnap.data() || {};
    if (chat.guestId !== userId && chat.partnerId !== userId) {
      return res
        .status(403)
        .json({ error: 'You are not allowed to modify this chat' });
    }

    const isGuest = chat.guestId === userId;
    const field = isGuest ? 'readByGuest' : 'readByPartner';

    const msgsSnap = await chatRef
      .collection('messages')
      .where(field, '==', false)
      .get();

    if (msgsSnap.empty) {
      return res.json({ success: true, updated: 0 });
    }

    const batch = firestore.batch();
    msgsSnap.forEach((doc) => {
      const updateData = {};
      updateData[field] = true;
      batch.update(doc.ref, updateData);
    });
    await batch.commit();

    return res.json({ success: true, updated: msgsSnap.size });
  } catch (err) {
    console.error('POST /chat/:chatId/read error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to mark messages as read' });
  }
});

module.exports = router;
