// routes/leadsRoutes.js
const express = require("express");
const router = express.Router();
const { admin, db } = require("../firebase-admin"); // adjust path if needed

router.post("/partner", async (req, res) => {
  try {
    const { venueName, location, email, source, page, userAgent } = req.body || {};

    if (!venueName || !location || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const doc = {
      venueName: String(venueName).trim(),
      location: String(location).trim(),
      email: String(email).trim().toLowerCase(),
      source: source || "landing",
      page: page || "",
      userAgent: userAgent || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "new",
    };

    const ref = await db.collection("partnerLeads").add(doc);
    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    console.error("POST /api/leads/partner error:", e);
    return res.status(500).json({
      error: "Server error",
      message: e?.message || String(e),
    });
  }
});

module.exports = router;