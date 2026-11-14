// Money out. Guarded twice: a transaction re-checks for open chargebacks, and a unique index
// (one_active_refund_per_order) makes a second refund for the same order impossible.
import { ObjectId } from "mongodb";
import { getClient } from "../db.js";
import { audit } from "../lib/audit.js";
import { httpError } from "../lib/http.js";
import { hashFootprint } from "../lib/privacy.js";

export async function issueRefund(db, { merchantId, claimId }) {
  const claim = await db.collection("claims").findOne({ _id: new ObjectId(claimId), merchantId });
  if (!claim) throw httpError(404, "Claim not found");
  if (claim.decision !== "APPROVE") throw httpError(409, `Claim decision is ${claim.decision}; only APPROVE can be refunded`);

  const session = getClient().startSession();
  try {
    let refund;
    await session.withTransaction(async () => {
      const dispute = await db.collection("disputes").findOne({ orderId: claim.orderId, status: "open" }, { session });
      if (dispute) throw httpError(409, "Open chargeback on this order; refunding would pay twice");
      refund = {
        merchantId, orderId: claim.orderId, customerId: claim.customerId, claimId: claim._id,
        amount: claim.amount, status: "succeeded", active: true, createdAt: new Date(), simulated: true,
      };
      await db.collection("refunds").insertOne(refund, { session });
      await db.collection("claims").updateOne({ _id: claim._id }, { $set: { status: "refunded" } }, { session });
    });
    await audit(db, "refund.issued", { merchantId, claimId: claim._id, orderId: claim.orderId, amount: claim.amount });
    return { refundId: refund._id, orderId: claim.orderId, amount: claim.amount, status: refund.status };
  } catch (err) {
    if (err.code === 11000) throw httpError(409, "This order already has a refund; refusing to pay twice");
    throw err;
  } finally {
    await session.endSession();
  }
}

/** "Forget me": delete memories and footprints; keep orders, refunds and disputes (legal records). */
export async function forgetCustomer(db, { merchantId, customerId }) {
  const customer = await db.collection("customers").findOne({ _id: customerId, merchantId });
  if (!customer) throw httpError(404, "Customer not found");

  const memories = await db.collection("memories").deleteMany({ "scope.merchantId": merchantId, "scope.customerId": customerId });
  const footprints = await db.collection("footprints").deleteMany({ merchantId, customerId });
  const claims = await db.collection("claims").updateMany(
    { merchantId, customerId },
    { $set: { text: "[forgotten]", callerQuestions: [] } },
  );
  await audit(db, "customer.forgotten", { merchantId, subject: hashFootprint("customer", customerId) });
  return {
    deleted: { memories: memories.deletedCount, footprints: footprints.deletedCount },
    scrubbed: { claimTexts: claims.modifiedCount },
    kept: ["orders", "refunds", "disputes"],
  };
}
