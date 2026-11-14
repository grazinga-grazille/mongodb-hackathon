// Governed memory: search, write, reinforce, correct, forget.
// Every read goes through searchMemories(), whose filter decides WHO CAN READ.
import { ObjectId } from "mongodb";
import { config, days } from "../config.js";
import { cosine, embed, scoreToCosine } from "../lib/embeddings.js";
import { scrubText } from "../lib/privacy.js";
import { VECTOR_INDEX } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { httpError } from "../lib/http.js";

const memories = (db) => db.collection("memories");

/** A merchant can read shared network memories plus its own private ones, never another merchant's. */
export const readableBy = (merchantId) => ({
  $or: [{ "scope.level": "network" }, { "scope.merchantId": merchantId }],
});

/** Vector search over memories the merchant is allowed to read. Returns cosine similarity per hit. */
export async function searchMemories(db, { merchantId, vector, types, limit = 3 }) {
  const hits = await memories(db)
    .aggregate([
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: "embedding",
          queryVector: vector,
          numCandidates: Math.max(50, limit * 20),
          limit,
          filter: { $and: [{ status: "active" }, { type: { $in: types } }, readableBy(merchantId)] },
        },
      },
      { $set: { score: { $meta: "vectorSearchScore" } } },
      { $unset: "embedding" },
    ])
    .toArray();
  return hits.map((h) => ({ ...h, cosine: Number(scoreToCosine(h.score).toFixed(3)) }));
}

/** Seen again: more confidence, and the TTL clock restarts. */
export function reinforce(db, ids, claimId) {
  if (!ids.length) return;
  return Promise.all(
    ids.map(async (_id) => {
      const m = await memories(db).findOne({ _id });
      if (!m) return;
      await memories(db).updateOne(
        { _id },
        {
          $inc: { seenCount: 1 },
          $set: { confidence: Math.min(1, (m.confidence ?? 0.5) + 0.1), expiresAt: days(config.ttlDays[m.type]) },
          $addToSet: { usedInDecisions: claimId },
        },
      );
    }),
  );
}

/** Store a confirmed scam story as a shared script, or reinforce a near-duplicate that already exists. */
export async function learnScript(db, { text, claimType, claimId }) {
  const clean = scrubText(text);
  const vector = await embed(clean, "document");
  const [nearest] = await memories(db)
    .aggregate([
      {
        $vectorSearch: {
          index: VECTOR_INDEX, path: "embedding", queryVector: vector, numCandidates: 50, limit: 1,
          filter: { $and: [{ status: "active" }, { type: "scam_script" }, { "scope.level": "network" }] },
        },
      },
      { $project: { embedding: 1 } },
    ])
    .toArray();

  if (nearest && cosine(nearest.embedding, vector) >= config.match.duplicate) {
    await reinforce(db, [nearest._id], claimId);
    return { action: "reinforced", memoryId: nearest._id };
  }
  const { insertedId } = await memories(db).insertOne({
    type: "scam_script", scope: { level: "network" }, text: clean, claimType, embedding: vector,
    confidence: 0.7, seenCount: 1, status: "active", version: 1,
    source: { actor: "analyst", claimId }, usedInDecisions: [claimId],
    createdAt: new Date(), expiresAt: days(config.ttlDays.scam_script),
  });
  return { action: "created", memoryId: insertedId };
}

/** Upsert a merchant-private memory about one customer (suspect_account / cleared_customer). */
export async function rememberCustomer(db, { merchantId, customerId, type, text, claimId }) {
  const filter = { type, status: "active", "scope.merchantId": merchantId, "scope.customerId": customerId };
  await memories(db).updateOne(
    filter,
    {
      $set: { text, expiresAt: days(config.ttlDays[type]), confidence: 0.9 },
      $inc: { seenCount: 1 },
      $addToSet: { usedInDecisions: claimId },
      $setOnInsert: {
        type, scope: { level: "merchant", merchantId, customerId }, status: "active", version: 1,
        source: { actor: "analyst", claimId }, createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/** Revoke (not delete) so the history of what the agent believed stays auditable. */
export function revokeCustomerMemories(db, { merchantId, customerId, type, by }) {
  return memories(db).updateMany(
    { type, status: "active", "scope.merchantId": merchantId, "scope.customerId": customerId },
    { $set: { status: "revoked", revokedAt: new Date(), revokedBy: by } },
  );
}

/** Correction = new version that supersedes the old one. Nothing is overwritten. */
export async function correctMemory(db, { merchantId, memoryId, text, actor }) {
  const old = await memories(db).findOne({ _id: new ObjectId(memoryId), status: "active", ...readableBy(merchantId) });
  if (!old) throw httpError(404, "Active memory not found");
  if (old.scope.level === "network" && actor !== "analyst") throw httpError(403, "Only analysts can correct shared memories");

  const clean = scrubText(text);
  const { _id, embedding, usedInDecisions, ...rest } = old;
  const next = {
    ...rest, text: clean, version: (old.version ?? 1) + 1, supersedes: old._id,
    source: { actor, correctedAt: new Date() }, usedInDecisions: [], createdAt: new Date(),
    ...(embedding ? { embedding: await embed(clean, "document") } : {}),
  };
  const { insertedId } = await memories(db).insertOne(next);
  await memories(db).updateOne({ _id: old._id }, { $set: { status: "superseded", supersededBy: insertedId } });
  await audit(db, "memory.corrected", { merchantId, memoryId: old._id, newMemoryId: insertedId, actor });
  return { memoryId: insertedId, version: next.version, supersedes: old._id };
}

/** Demo helper: make a memory expire now; Atlas's TTL monitor removes it within ~60 seconds. */
export async function expireNow(db, { merchantId, memoryId }) {
  const r = await memories(db).updateOne(
    { _id: new ObjectId(memoryId), ...readableBy(merchantId) },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  if (!r.matchedCount) throw httpError(404, "Memory not found");
  await audit(db, "memory.expired_early", { merchantId, memoryId });
  return { ok: true, note: "Atlas TTL monitor deletes it within about 60 seconds" };
}
