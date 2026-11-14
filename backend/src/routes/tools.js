// The voice agent's tools. Each request is scoped to one merchant via the x-merchant-id header.
// (Production: a per-merchant API key resolves the merchant; never a value the caller can choose.)
import { Router } from "express";
import { getDb } from "../db.js";
import { httpError, requireString, wrap } from "../lib/http.js";
import { checkClaim, recordOutcome, normalizeOrderId } from "../services/claims.js";
import { issueRefund, forgetCustomer } from "../services/refunds.js";

export const requireMerchant = wrap(async (req, _res, next) => {
  const merchantId = req.get("x-merchant-id");
  if (!merchantId) throw httpError(401, "x-merchant-id header is required");
  if (!(await getDb().collection("merchants").findOne({ _id: merchantId }))) throw httpError(403, "Unknown merchant");
  req.merchantId = merchantId;
  next();
});

export const tools = Router();
tools.use(requireMerchant);

tools.post("/check-claim", wrap(async (req, res) => {
  const { orderId, claimText, callerQuestions = [], claimType } = req.body ?? {};
  if (!Array.isArray(callerQuestions) || callerQuestions.length > 5) throw httpError(400, "callerQuestions must be an array (max 5)");
  res.json(await checkClaim(getDb(), {
    merchantId: req.merchantId,
    orderId: normalizeOrderId(requireString(orderId, "orderId", { max: 64 })),
    claimText: requireString(claimText, "claimText"),
    callerQuestions: callerQuestions.map((q) => requireString(q, "callerQuestions[]", { max: 500 })),
    claimType,
  }));
}));

tools.post("/issue-refund", wrap(async (req, res) => {
  res.status(201).json(await issueRefund(getDb(), { merchantId: req.merchantId, claimId: requireString(req.body?.claimId, "claimId", { max: 24 }) }));
}));

tools.post("/record-outcome", wrap(async (req, res) => {
  const { claimId, outcome, analyst } = req.body ?? {};
  res.json(await recordOutcome(getDb(), { merchantId: req.merchantId, claimId: requireString(claimId, "claimId", { max: 24 }), outcome, analyst }));
}));

tools.post("/forget-me", wrap(async (req, res) => {
  res.json(await forgetCustomer(getDb(), { merchantId: req.merchantId, customerId: requireString(req.body?.customerId, "customerId", { max: 64 }) }));
}));
