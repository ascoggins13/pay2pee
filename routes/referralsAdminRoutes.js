const express = require("express");
const { body, validationResult } = require("express-validator");
const protect = require("../middleware/protect");
const {
  createReferrer,
  assignReferrerToLocation,
} = require("../services/referralsService");

const router = express.Router();

// Add your real admin middleware if you have one
const adminOnly = protect;

router.post(
  "/referrers",
  adminOnly,
  [body("name").notEmpty().withMessage("name is required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const referrer = await createReferrer(req.body);
      return res.status(201).json(referrer);
    } catch (err) {
      console.error("create referrer error:", err);
      return res.status(500).json({ error: err.message || "Failed to create referrer" });
    }
  }
);

router.post(
  "/locations/:locationId/assign",
  adminOnly,
  [
    body("partnerId").notEmpty().withMessage("partnerId is required"),
    body("referrerId").notEmpty().withMessage("referrerId is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const referral = await assignReferrerToLocation({
        locationId: req.params.locationId,
        partnerId: req.body.partnerId,
        referrerId: req.body.referrerId,
        referrerName: req.body.referrerName || null,
        referralId: req.body.referralId || null,
        attributionType: req.body.attributionType || "manual",
        createdBy: req.user?.id || req.user?.userId || "admin",
      });

      return res.status(201).json(referral);
    } catch (err) {
      console.error("assign referrer error:", err);
      return res.status(500).json({ error: err.message || "Failed to assign referrer" });
    }
  }
);

module.exports = router;