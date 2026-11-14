// The decision engine. Vector search for what the caller SAYS; exact checks for what HAPPENED.
// Deterministic rules decide; the voice agent only explains. Every decision records the memories it used.
import { ObjectId } from "mongodb";
import { config, days, daysAgo } from "../config.js";
import { scrubText } from "../lib/privacy.js";
import { cosine, embed } from "../lib/embeddings.js";
import { audit } from "../lib/audit.js";
import { httpError } from "../lib/http.js";
import { searchMemories, learnScript, rememberCustomer, revokeCustomerMemories, reinforce } from "./memory.js";

const W = config.risk.weights;

// ---------- claim type (semantic classification against a few examples) ----------
const PROTOTYPES = {
  never_arrived: ["My package never arrived", "I never received my order", "It never turned up", "The delivery didn't show up", "I haven't got my item"],
  empty_box: ["The box was empty", "The package arrived with nothing inside", "The item was missing from the box",
    "I ordered headphones and the box was empty", "I opened the box and there was nothing in it, just packaging"],
  damaged: ["The item arrived broken", "It was damaged when it arrived", "It came smashed"],
  wrong_item: ["I received the wrong item", "They sent me something I didn't order"],
};
const MIN_CLASSIFY_COSINE = 0.68;
let prototypeVectors;

async function classifyClaim(vector) {
  if (!prototypeVectors) {
    prototypeVectors = [];
    for (const [type, examples] of Object.entries(PROTOTYPES)) {
      for (const v of await embed(examples, "document")) prototypeVectors.push({ type, v });
    }
  }
  const best = prototypeVectors.reduce((a, p) => {
    const s = cosine(vector, p.v);
    return s > a.s ? { type: p.type, s } : a;
  }, { type: "other", s: 0 });
  return best.s >= MIN_CLASSIFY_COSINE ? best.type : "other";
}

// ---------- individual checks ----------
function deliveryCheck(order, claimType) {
  const d = order.delivery ?? {};
  if (claimType === "never_arrived" && d.status === "delivered") {
    return d.photo
      ? { code: "delivery_contradiction", weight: W.delivery_contradiction, detail: "Carrier marked it delivered, with a photo at the door" }
      : { code: "delivery_contradiction", weight: 1, detail: "Carrier marked it delivered (no photo)" };
  }
  if (claimType === "empty_box" && d.dispatchWeightKg >= 0.9 * order.item.weightKg) {
    return { code: "delivery_contradiction", weight: W.delivery_contradiction,
      detail: `Parcel weighed ${d.dispatchWeightKg} kg at dispatch, matching the item (${order.item.weightKg} kg)` };
  }
  return null;
}

async function repeatClaimsCheck(db, { merchantId, customerId, orderId }) {
  const n = await db.collection("claims").countDocuments({
    merchantId, customerId, orderId: { $ne: orderId }, createdAt: { $gte: daysAgo(config.windowsDays.repeatClaims) },
  });
  return n > 0
    ? { code: "repeat_claims", weight: W.repeat_claims, detail: `${n} other claim(s) from this account in ${config.windowsDays.repeatClaims} days` }
    : null;
}

/** Footprint: other accounts at this merchant sharing an address, card or device hash. */
async function footprintCheck(db, { merchantId, customerId }) {
  const cleared = await db.collection("memories").findOne({
    type: "cleared_customer", status: "active", "scope.merchantId": merchantId, "scope.customerId": customerId,
  });
  if (cleared) return { signal: null, clearedMemoryId: cleared._id };

  const mine = await db.collection("footprints").findOne({ merchantId, customerId });
  if (!mine) return { signal: null };
  const keys = ["addressHash", "cardHash", "deviceHash"];
  const linked = await db.collection("footprints")
    .find({ merchantId, customerId: { $ne: customerId }, $or: keys.map((k) => ({ [k]: mine[k] })) })
    .toArray();
  if (!linked.length) return { signal: null, linked: [] };

  const ids = linked.map((l) => l.customerId);
  const sharedOn = (l) => keys.filter((k) => l[k] === mine[k]).map((k) => k.replace("Hash", ""));
  const linkedInfo = linked.map((l) => ({ customerId: l.customerId, sharedOn: sharedOn(l) }));

  const suspects = await db.collection("memories").find({
    type: "suspect_account", status: "active", "scope.merchantId": merchantId, "scope.customerId": { $in: ids },
  }).toArray();
  if (suspects.length) {
    const l = linked.find((x) => x.customerId === suspects[0].scope.customerId);
    return {
      signal: { code: "linked_to_confirmed_scam", weight: W.linked_to_confirmed_scam,
        detail: `Shares ${sharedOn(l).join(" + ")} with an account confirmed as a refund scam`, linkedCustomerId: l.customerId },
      memoryIds: suspects.map((s) => s._id),
      linked: linkedInfo,
    };
  }
  const escalated = await db.collection("claims").findOne({
    merchantId, customerId: { $in: ids }, status: { $in: ["escalated", "confirmed_scam"] },
    createdAt: { $gte: daysAgo(config.windowsDays.linkedClaims) },
  });
  if (escalated) {
    const l = linked.find((x) => x.customerId === escalated.customerId);
    return { signal: { code: "linked_to_escalated", weight: W.linked_to_escalated,
      detail: `Shares ${sharedOn(l).join(" + ")} with an account that has an escalated claim`, linkedCustomerId: l.customerId }, linked: linkedInfo };
  }
  return { signal: null, linked: linkedInfo };
}

/**
 * Same story, different account: vector-search the stories told by accounts that share this
 * caller's address/card/device. Catches one person claiming again under a new name.
 */
async function sameStoryCheck(db, { merchantId, vector, claimType, linked, force = false }) {
  if (!linked?.length) return null;
  const linkedIds = linked.map((l) => l.customerId);
  const hits = await searchMemories(db, {
    merchantId, vector, types: ["claim_story"], limit: 5,
    filter: { "scope.customerId": { $in: linkedIds } },
  });
  // Atlas Vector Search indexes new documents asynchronously (about a second). Stories saved in the
  // last minute may not be searchable yet, so compare those few directly against the same vector.
  const fresh = await db.collection("memories").find({
    type: "claim_story", status: "active", "scope.merchantId": merchantId, "scope.customerId": { $in: linkedIds },
    createdAt: { $gte: new Date(Date.now() - 60_000) }, _id: { $nin: hits.map((h) => h._id) },
  }).toArray();
  for (const { embedding, ...m } of fresh) hits.push({ ...m, cosine: Number(cosine(vector, embedding).toFixed(3)) });
  hits.sort((a, b) => b.cosine - a.cosine);

  // Same kind of claim (e.g. both "box was empty") and close in meaning.
  // Very close in meaning counts on its own, so a mislabelled claim type can't hide a match.
  const hit =
    hits.find((h) => (h.claimType === claimType && h.cosine >= config.match.story) || h.cosine >= config.match.storyStrong) ??
    (force ? hits[0] : undefined); // demo override: use the closest linked story, whatever its score
  if (!hit) return null;

  const other = await db.collection("customers").findOne({ _id: hit.scope.customerId }, { projection: { name: 1 } });
  const shared = linked.find((l) => l.customerId === hit.scope.customerId)?.sharedOn ?? [];
  return {
    code: "same_story_linked_account", weight: W.same_story_linked_account, similarity: hit.cosine, memoryId: hit._id,
    linkedCustomerId: hit.scope.customerId,
    detail: `Same story as ${other?.name ?? "another account"} (shares ${shared.join(" + ")}), who claimed on ${hit.orderId}: "${hit.text}"`,
    // For the dashboard's side-by-side comparison.
    match: { name: other?.name ?? "Another account", orderId: hit.orderId, text: hit.text, sharedOn: shared },
  };
}

const GUIDANCE = {
  APPROVE: "Tell the caller their refund is approved, then call issue-refund with this claimId.",
  ESCALATE: "Tell the caller a specialist will review the claim within 24 hours. Do not mention fraud or any signals.",
  DECLINE: "Explain the reason politely (already refunded, or their bank is already handling a dispute). Do not issue a refund.",
};

// ---------- main entry ----------
export async function checkClaim(db, { merchantId, orderId, claimText, callerQuestions = [], claimType }) {
  const order = await db.collection("orders").findOne({ _id: orderId, merchantId });
  if (!order) throw httpError(404, `Order ${orderId} not found for this merchant`);
  const { customerId } = order; // never trust the caller for identity: derive it from the order

  const signals = [];
  const memoryIdsUsed = [];
  let decision;

  // 1. Hard stops: money already went out, or a chargeback is open (paying twice).
  const [refund, dispute] = await Promise.all([
    db.collection("refunds").findOne({ orderId, active: true }),
    db.collection("disputes").findOne({ orderId, status: "open" }),
  ]);
  if (refund) signals.push({ code: "already_refunded", hardStop: true, detail: `Refunded $${refund.amount} on ${refund.createdAt.toISOString().slice(0, 10)}` });
  if (dispute) signals.push({ code: "open_chargeback", hardStop: true, detail: "The caller's bank already has an open dispute on this order" });

  // 2. What the caller SAYS (vector search over governed memory).
  // Embed what happened, not which order: order numbers skew the meaning (and the claim type).
  const [claimVec, ...questionVecs] = await embed([meaningOf(claimText), ...callerQuestions], "query");
  const type = claimType || (await classifyClaim(claimVec));

  const [script] = await searchMemories(db, { merchantId, vector: claimVec, types: ["scam_script"], limit: 1 });
  if (script && script.cosine >= config.match.script) {
    signals.push({ code: "script_match", weight: W.script_match, detail: `Sounds like a known scam script: "${script.text}"`, memoryId: script._id, similarity: script.cosine });
    memoryIdsUsed.push(script._id);
  }
  for (const [i, qv] of questionVecs.entries()) {
    const [probe] = await searchMemories(db, { merchantId, vector: qv, types: ["probe_phrase"], limit: 1 });
    if (probe && probe.cosine >= config.match.probe) {
      signals.push({ code: "policy_probing", weight: W.policy_probing, detail: `"${callerQuestions[i]}" sounds like probing: "${probe.text}"`, memoryId: probe._id, similarity: probe.cosine });
      memoryIdsUsed.push(probe._id);
      break; // count probing once
    }
  }

  // 3. What HAPPENED (exact checks).
  const delivery = deliveryCheck(order, type);
  if (delivery) signals.push(delivery);
  const repeat = await repeatClaimsCheck(db, { merchantId, customerId, orderId });
  if (repeat) signals.push(repeat);
  const fp = await footprintCheck(db, { merchantId, customerId });
  if (fp.signal) signals.push(fp.signal);
  if (fp.memoryIds) memoryIdsUsed.push(...fp.memoryIds);
  if (fp.clearedMemoryId) memoryIdsUsed.push(fp.clearedMemoryId);
  const forced = config.demoForceEscalate.includes(customerId); // DEMO ONLY (see config.js)
  const story = await sameStoryCheck(db, { merchantId, vector: claimVec, claimType: type, linked: fp.linked, force: forced });
  if (story) {
    signals.push(story);
    memoryIdsUsed.push(story.memoryId);
  }

  // 4. Decide.
  const riskScore = signals.reduce((s, x) => s + (x.weight ?? 0), 0);
  // An open bank dispute is a hard DECLINE. A repeat claim on an already-refunded order goes to a
  // specialist instead (no refund either way, but a person should look at a repeat claim).
  if (dispute) decision = "DECLINE";
  else if (refund || forced) decision = "ESCALATE";
  else decision = riskScore >= config.risk.escalateAt ? "ESCALATE" : "APPROVE";

  const status = { APPROVE: "approved", ESCALATE: "escalated", DECLINE: "declined" }[decision];
  const { insertedId: claimId } = await db.collection("claims").insertOne({
    merchantId, orderId, customerId, amount: order.amount, claimType: type, text: claimText,
    callerQuestions, decision, riskScore, signals, memoryIdsUsed, status, createdAt: new Date(),
  });
  if (memoryIdsUsed.length) {
    await db.collection("memories").updateMany({ _id: { $in: memoryIdsUsed } }, { $addToSet: { usedInDecisions: claimId } });
  }
  // Remember this caller's story so a linked account telling it again is caught next time.
  // Private to this merchant, tied to this customer (forget-me deletes it), expires via TTL.
  await db.collection("memories").insertOne({
    type: "claim_story", scope: { level: "merchant", merchantId, customerId },
    text: scrubText(claimText), embedding: claimVec, claimType: type, orderId, claimId,
    status: "active", version: 1, seenCount: 1, confidence: 0.5, source: { actor: "agent", claimId },
    usedInDecisions: [], createdAt: new Date(), expiresAt: days(config.ttlDays.claim_story),
  });
  await audit(db, "claim.checked", { merchantId, claimId, orderId, decision, riskScore });

  // Previous conversations (customer-facing context only: no decisions or fraud signals).
  const previousContacts = await db.collection("calls")
    .find({ merchantId, customerId }, { projection: { _id: 0, createdAt: 1, summary: 1 } })
    .sort({ createdAt: -1 }).limit(3).toArray();

  return {
    claimId, decision, riskScore, escalateAt: config.risk.escalateAt, claimType: type,
    order: { id: order._id, item: order.item.name, amount: order.amount },
    signals, memoryIdsUsed, previousContacts, agentGuidance: GUIDANCE[decision],
  };
}

/** Remove order numbers so the embedding captures only the story: "order 2058, the box was empty" -> "the box was empty". */
const NUM_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)";
// "order twenty fifty-eight", "order number three oh four six", "order #2058"
const ORDER_PHRASE = new RegExp(
  `\\b(?:my\\s+)?order(?:\\s+(?:number|no\\.?|#))?\\s*(?:is\\s+)?#?\\s*(?:[\\d-]+|${NUM_WORD}(?:[\\s-]+${NUM_WORD})*)(?:[\\s-]+[\\d]+)*`,
  "gi",
);

export function meaningOf(text) {
  const cleaned = text
    .replace(ORDER_PHRASE, " ")
    .replace(/#?\b\d{3,}\b/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([,.])\s*[,.]+/g, "$1")
    .replace(/^[\s,.]+|\s{2,}/g, (m) => (m.trim() ? "" : " "))
    .trim();
  return cleaned || text;
}

/** Accept "1042", "ord_1042", "order number 1042" or "#1042". */
export function normalizeOrderId(input) {
  const digits = String(input).match(/\d+/g)?.join("");
  return digits ? `ord_${digits}` : String(input);
}

// ---------- analyst feedback: this is what changes the next run ----------
export async function recordOutcome(db, { merchantId, claimId, outcome, analyst = "analyst" }) {
  if (!["confirmed_scam", "cleared"].includes(outcome)) throw httpError(400, "outcome must be confirmed_scam or cleared");
  const claim = await db.collection("claims").findOne({ _id: new ObjectId(claimId), merchantId });
  if (!claim) throw httpError(404, "Claim not found");
  const result = { claimId: claim._id, outcome, memories: [] };

  if (outcome === "confirmed_scam") {
    const learned = await learnScript(db, { text: claim.text, claimType: claim.claimType, claimId: claim._id });
    result.memories.push({ type: "scam_script", ...learned });
    await rememberCustomer(db, {
      merchantId, customerId: claim.customerId, type: "suspect_account", claimId: claim._id,
      text: `Confirmed refund scam on order ${claim.orderId} (${claim.claimType})`,
    });
    result.memories.push({ type: "suspect_account", action: "upserted" });
    await revokeCustomerMemories(db, { merchantId, customerId: claim.customerId, type: "cleared_customer", by: analyst });
    await reinforce(db, claim.memoryIdsUsed ?? [], claim._id); // the memories that caught it were right
  } else {
    await rememberCustomer(db, {
      merchantId, customerId: claim.customerId, type: "cleared_customer", claimId: claim._id,
      text: `Analyst cleared this customer after reviewing claim on ${claim.orderId}`,
    });
    const revoked = await revokeCustomerMemories(db, { merchantId, customerId: claim.customerId, type: "suspect_account", by: analyst });
    result.memories.push({ type: "cleared_customer", action: "upserted" }, { type: "suspect_account", action: `revoked ${revoked.modifiedCount}` });
  }

  await db.collection("claims").updateOne({ _id: claim._id }, { $set: { status: outcome, reviewedBy: analyst, reviewedAt: new Date() } });
  await audit(db, "claim.outcome", { merchantId, claimId: claim._id, outcome, analyst });
  return result;
}
