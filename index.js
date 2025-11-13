// index.js — Pay2Pee Backend (Firestore + Stripe + Connect)
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

// Firebase Admin (centralized here)
const {
  admin,
  firestore,
  getFirebaseConfigInfo,
  firestoreSmokeTest,
} = require("./firebase-admin");

const app = express();

/* -------------------- Core middleware -------------------- */
app.set("trust proxy", 1);

app.use(
  cors({
    origin: ["https://pay2pee.app", "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

/* ---------------- Stripe webhooks (RAW FIRST) ------------- */
// Must come BEFORE any JSON/body parsers
const stripeWebhooksRouter = require("./routes/stripeWebhooksRoutes");
app.use("/api/webhooks/stripe", stripeWebhooksRouter);
// legacy alias if you ever used this URL:
app.use("/stripe-webhooks", stripeWebhooksRouter);

/* --------------- Body parsers (AFTER webhooks) ------------ */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ---------------------- Debug routes ---------------------- */
// Quick check of Firebase project + bucket wiring
app.get("/api/_debug/firebase", (req, res) => {
  try {
    const info = getFirebaseConfigInfo();
    res.json(info);
  } catch (err) {
    console.error("[_debug/firebase] error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Actually perform a Firestore write+read
app.get("/api/_debug/fs-smoketest", async (req, res) => {
  try {
    const result = await firestoreSmokeTest();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[_debug/fs-smoketest] error:", err);
    res
      .status(500)
      .json({ ok: false, code: err.code, message: err.message || String(err) });
  }
});

/* ---------------------- Healthcheck ----------------------- */
app.get("/api/healthcheck", async (_req, res) => {
  try {
    // Lightweight doc read instead of a query (avoids gRPC NOT_FOUND noise)
    const ref = firestore.collection("_meta").doc("health");
    await ref.set(
      { lastCheck: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    const snap = await ref.get();

    res.json({
      status: "healthy",
      serverTime: new Date().toISOString(),
      dbStatus: "connected",
      firebaseStatus: admin.apps.length ? "connected" : "disconnected",
      metaExists: snap.exists,
    });
  } catch (err) {
    console.error("[healthcheck] error:", err);
    res.json({
      status: "degraded",
      serverTime: new Date().toISOString(),
      dbStatus: "unreachable",
      firebaseStatus: admin.apps.length ? "connected" : "disconnected",
      error: err.message || String(err),
    });
  }
});

/* ------------------------ API Routes ---------------------- */
// Simple routers (each file: module.exports = router)
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/locations", require("./routes/locationRoutes"));
app.use("/api/bathrooms", require("./routes/bathroomImageRoutes"));
app.use("/api/subscriptions", require("./routes/subscriptions"));
app.use("/api/payments", require("./routes/paymentsRoutes"));

// Partner routes: your file may export { partnerRouter, hostRouter }
(() => {
  const partnerModule = require("./routes/partnerRoutes");

  if (partnerModule && (partnerModule.partnerRouter || partnerModule.hostRouter)) {
    if (partnerModule.partnerRouter) {
      app.use("/api/partner", partnerModule.partnerRouter);
    }
    if (partnerModule.hostRouter) {
      app.use("/api/host", partnerModule.hostRouter);
    }
  } else {
    // Fallback if it just exports a single router
    app.use("/api/partner", partnerModule);
  }
})();

// If/when you add Stripe Connect account onboarding endpoints:
// app.use("/api/connect", require("./routes/connectRoutes"));

/* --------------- Serve client (optional) ------------------ */
// Only if you later decide to serve React from this server
if (process.env.NODE_ENV === "production" && process.env.SERVE_CLIENT === "true") {
  app.use(express.static(path.join(__dirname, "client/build")));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "client/build", "index.html"));
  });
}

/* ---------------- 404 + Error handlers -------------------- */
app.use((req, res) =>
  res.status(404).json({ success: false, error: "Endpoint not found" })
);

app.use((err, _req, res, _next) => {
  console.error("⚠️ Server Error:", err);
  res.status(500).json({
    success: false,
    error:
      process.env.NODE_ENV === "development"
        ? err.message || String(err)
        : "Server error",
  });
});

/* -------------------- Start server ------------------------ */
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Pay2Pee server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
});

/* ------------------ Graceful shutdown --------------------- */
process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down gracefully...");
  server.close(() => console.log("Process terminated"));
});

