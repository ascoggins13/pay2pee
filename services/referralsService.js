const admin = require("firebase-admin");

const db = admin.firestore();

const referrersCol = db.collection("referrers");
const locationReferralsCol = db.collection("locationReferrals");
const paymentEarningsCol = db.collection("paymentEarnings");
const referralPayoutsCol = db.collection("referralPayouts");

const DEFAULT_COMMISSION_RATE = 0.10;
const DEFAULT_PLATFORM_FEE_RATE = 0.30;
const DEFAULT_BASE_WINDOW_MONTHS = 3;
const DEFAULT_MAX_WINDOW_MONTHS = 12;

function nowTs() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return admin.firestore.Timestamp.fromDate(d);
}

function dateKeyUTC(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function createReferrer({
  name,
  email = null,
  phone = null,
  socialHandle = null,
  city = null,
  type = "other",
  status = "pending",
  paymentMethodType = null,
  paymentMethodValue = null,
  notes = null,
}) {
  const docRef = referrersCol.doc();

  const payload = {
    name,
    email,
    phone,
    socialHandle,
    city,
    type,
    status,
    paymentMethodType,
    paymentMethodValue,
    notes,

    totalApprovedLocations: 0,
    totalPlatformEarnings: 0,
    totalCommissionEarned: 0,
    totalCommissionPaid: 0,
    totalCommissionUnpaid: 0,

    createdAt: nowTs(),
    approvedAt: status === "approved" ? nowTs() : null,
    updatedAt: nowTs(),
  };

  await docRef.set(payload);

  return { id: docRef.id, ...payload };
}

async function assignReferrerToLocation({
  locationId,
  partnerId,
  referrerId,
  referrerName,
  referralId = null,
  attributionType = "manual",
  commissionRate = DEFAULT_COMMISSION_RATE,
  platformFeeRate = DEFAULT_PLATFORM_FEE_RATE,
  baseWindowMonths = DEFAULT_BASE_WINDOW_MONTHS,
  maxWindowMonths = DEFAULT_MAX_WINDOW_MONTHS,
  createdBy = "system",
}) {
  if (!locationId) throw new Error("locationId is required");
  if (!partnerId) throw new Error("partnerId is required");
  if (!referrerId) throw new Error("referrerId is required");

  const docRef = locationReferralsCol.doc(locationId);
  const snap = await docRef.get();

  if (snap.exists) {
    throw new Error("A referrer is already assigned to this location");
  }

  const payload = {
    locationId,
    partnerId,
    referralId,
    referrerId,
    referrerName: referrerName || null,

    status: "approved", // pending | approved | earning | paused | ended | rejected
    attributionType, // manual | referral_code | form_submission

    commissionRate,
    platformFeeRate,
    baseWindowMonths,
    currentWindowMonths: baseWindowMonths,
    extensionTier: 0,
    maxWindowMonths,

    qualifiedAt: nowTs(),
    earningsStartAt: null,
    earningsEndAt: null,
    firstPaidTransactionAt: null,
    lastPaidTransactionAt: null,

    activeDaysCount: 0,
    grossRevenueTotal: 0,
    platformEarningsTotal: 0,
    referralCommissionTotal: 0,
    unpaidCommissionTotal: 0,
    paidCommissionTotal: 0,
    transactionCount: 0,

    milestone1Reached: false,
    milestone1ReachedAt: null,
    milestone2Reached: false,
    milestone2ReachedAt: null,
    milestone3Reached: false,
    milestone3ReachedAt: null,

    activeDateKeys: [],

    createdAt: nowTs(),
    updatedAt: nowTs(),
    createdBy,
  };

  await docRef.set(payload);

  await referrersCol.doc(referrerId).set(
    {
      totalApprovedLocations: admin.firestore.FieldValue.increment(1),
      updatedAt: nowTs(),
    },
    { merge: true }
  );

  return { id: docRef.id, ...payload };
}

async function recordPaymentEarning({
  stripeEventId,
  stripeSessionId,
  stripePaymentIntentId = null,
  userId = null,
  partnerId = null,
  locationId = null,
  destinationAccountId = null,
  grossAmount,
  platformFeeAmount,
  currency = "usd",
  paidAtDate = new Date(),
}) {
  if (!stripeSessionId) throw new Error("stripeSessionId is required");
  if (!locationId) throw new Error("locationId is required");
  if (!partnerId) throw new Error("partnerId is required");
  if (!Number.isInteger(grossAmount)) throw new Error("grossAmount must be cents integer");
  if (!Number.isInteger(platformFeeAmount)) throw new Error("platformFeeAmount must be cents integer");

  const paymentRef = paymentEarningsCol.doc(stripeSessionId);
  const existing = await paymentRef.get();
  if (existing.exists) {
    return { id: existing.id, ...existing.data(), alreadyExisted: true };
  }

  const paidAtTs = admin.firestore.Timestamp.fromDate(paidAtDate);
  const paidKey = dateKeyUTC(paidAtDate);

  const locationReferralRef = locationReferralsCol.doc(locationId);
  const locationReferralSnap = await locationReferralRef.get();
  const locationReferral = locationReferralSnap.exists ? locationReferralSnap.data() : null;

  const referralEligible = !!locationReferral && ["approved", "earning"].includes(locationReferral.status);
  const commissionRate = referralEligible
    ? Number(locationReferral.commissionRate || DEFAULT_COMMISSION_RATE)
    : 0;

  const referralCommissionAmount = referralEligible
    ? Math.round(platformFeeAmount * commissionRate)
    : 0;

  const partnerTransferAmount = grossAmount - platformFeeAmount;

  const paymentPayload = {
    stripeEventId: stripeEventId || null,
    stripeSessionId,
    stripePaymentIntentId,

    type: "guest_pass",
    paymentStatus: "paid",

    userId,
    partnerId,
    locationId,
    destinationAccountId,

    grossAmount,
    platformFeeAmount,
    partnerTransferAmount,
    currency,

    referralEligible,
    referrerId: referralEligible ? locationReferral.referrerId : null,
    commissionRate,
    referralCommissionAmount,

    paidAt: paidAtTs,
    paidDateKey: paidKey,
    paidDayOfWeek: paidAtDate.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),

    payoutStatus: referralEligible ? "unpaid" : "not_applicable",
    payoutId: null,

    createdAt: nowTs(),
    updatedAt: nowTs(),
  };

  await db.runTransaction(async (tx) => {
    tx.set(paymentRef, paymentPayload);

    if (!locationReferral) return;

    const refSnap = await tx.get(locationReferralRef);
    if (!refSnap.exists) return;

    const refData = refSnap.data() || {};
    const activeDateKeys = Array.isArray(refData.activeDateKeys) ? refData.activeDateKeys : [];
    const isNewActiveDay = !activeDateKeys.includes(paidKey);

    const updates = {
      status: "earning",
      grossRevenueTotal: admin.firestore.FieldValue.increment(grossAmount),
      platformEarningsTotal: admin.firestore.FieldValue.increment(platformFeeAmount),
      referralCommissionTotal: admin.firestore.FieldValue.increment(referralCommissionAmount),
      unpaidCommissionTotal: admin.firestore.FieldValue.increment(referralCommissionAmount),
      transactionCount: admin.firestore.FieldValue.increment(1),
      lastPaidTransactionAt: paidAtTs,
      updatedAt: nowTs(),
    };

    if (!refData.firstPaidTransactionAt) {
      updates.firstPaidTransactionAt = paidAtTs;
      updates.earningsStartAt = paidAtTs;
      updates.earningsEndAt = addMonths(paidAtDate, Number(refData.baseWindowMonths || DEFAULT_BASE_WINDOW_MONTHS));
    }

    if (isNewActiveDay) {
      updates.activeDaysCount = admin.firestore.FieldValue.increment(1);
      updates.activeDateKeys = admin.firestore.FieldValue.arrayUnion(paidKey);
    }

    tx.set(locationReferralRef, updates, { merge: true });

    if (refData.referrerId) {
      tx.set(
        referrersCol.doc(refData.referrerId),
        {
          totalPlatformEarnings: admin.firestore.FieldValue.increment(platformFeeAmount),
          totalCommissionEarned: admin.firestore.FieldValue.increment(referralCommissionAmount),
          totalCommissionUnpaid: admin.firestore.FieldValue.increment(referralCommissionAmount),
          updatedAt: nowTs(),
        },
        { merge: true }
      );
    }
  });

  return { id: paymentRef.id, ...paymentPayload, alreadyExisted: false };
}

module.exports = {
  createReferrer,
  assignReferrerToLocation,
  recordPaymentEarning,
  referrersCol,
  locationReferralsCol,
  paymentEarningsCol,
  referralPayoutsCol,
};