const express = require("express");
const { body, validationResult } = require("express-validator");
const { firestore, admin } = require("../firebase-admin");

const router = express.Router();
const referralApplicationsCol = firestore.collection("referralApplications");

router.post(
  "/apply",
  [
    body("name").notEmpty().withMessage("name is required"),
    body("email").optional({ checkFalsy: true }).isEmail().withMessage("valid email required"),
    body("phone").optional({ checkFalsy: true }).isString(),
    body("type").optional({ checkFalsy: true }).isString(),
    body("city").optional({ checkFalsy: true }).isString(),
    body("estimatedLocations").optional({ checkFalsy: true }).isString(),
    body("notes").optional({ checkFalsy: true }).isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const {
        name,
        email = null,
        phone = null,
        type = "other",
        city = null,
        estimatedLocations = null,
        notes = null,
      } = req.body;

      const docRef = referralApplicationsCol.doc();

      await docRef.set({
        name,
        email,
        phone,
        type,
        city,
        estimatedLocations,
        notes,
        status: "pending",
        source: "referral_apply_page",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(201).json({ success: true, id: docRef.id });
    } catch (err) {
      console.error("POST /api/referrals/apply error:", err);
      return res.status(500).json({ error: err.message || "Failed to submit application" });
    }
  }
);

module.exports = router;