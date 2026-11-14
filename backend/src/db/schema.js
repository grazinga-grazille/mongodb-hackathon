// Collections, validators and indexes. Governance rules are enforced HERE (by the database), not in prompts.
import { embeddingDims } from "../lib/embeddings.js";

export const VECTOR_INDEX = "memory_vec";
export const MEMORY_TYPES = ["scam_script", "probe_phrase", "suspect_account", "cleared_customer"];

const memoryValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["type", "scope", "text", "status", "expiresAt", "createdAt"],
    properties: {
      type: { enum: MEMORY_TYPES },
      // Who can read: network memories are shared and may NOT carry merchant or customer ids.
      scope: {
        bsonType: "object",
        required: ["level"],
        oneOf: [
          { properties: { level: { enum: ["merchant"] } }, required: ["level", "merchantId"] },
          {
            properties: { level: { enum: ["network"] } },
            not: { anyOf: [{ required: ["merchantId"] }, { required: ["customerId"] }] },
          },
        ],
      },
      // PCI: a card-number-like sequence can never be stored in memory text.
      text: { bsonType: "string", maxLength: 2000, not: { pattern: "(?:\\d[ -]?){13,19}" } },
      status: { enum: ["active", "superseded", "revoked"] },
      expiresAt: { bsonType: "date" },
      embedding: { bsonType: "array" },
      version: { bsonType: "int" },
    },
  },
};

const COLLECTIONS = {
  merchants: null,
  customers: null,
  orders: null,
  footprints: null,
  claims: null,
  refunds: null,
  disputes: null,
  memories: memoryValidator,
  audit_log: null,
};

const INDEXES = {
  orders: [{ key: { merchantId: 1, customerId: 1 } }],
  footprints: [
    { key: { merchantId: 1, customerId: 1 }, unique: true },
    { key: { merchantId: 1, addressHash: 1 } },
    { key: { merchantId: 1, cardHash: 1 } },
    { key: { merchantId: 1, deviceHash: 1 } },
  ],
  claims: [{ key: { merchantId: 1, customerId: 1, createdAt: -1 } }, { key: { orderId: 1 } }],
  // Paying twice is impossible at the database level: one active refund per order.
  refunds: [{ key: { orderId: 1 }, unique: true, partialFilterExpression: { active: true }, name: "one_active_refund_per_order" }],
  disputes: [{ key: { orderId: 1, status: 1 } }],
  memories: [
    // How long it lives: Atlas deletes each memory when its expiresAt passes.
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "memory_ttl" },
    { key: { "scope.merchantId": 1, "scope.customerId": 1, type: 1, status: 1 } },
  ],
  audit_log: [{ key: { at: -1 } }],
};

function vectorIndexDefinition() {
  return {
    fields: [
      { type: "vector", path: "embedding", numDimensions: embeddingDims(), similarity: "cosine" },
      // Filter fields: vector search can only ever return memories the caller is allowed to read.
      { type: "filter", path: "type" },
      { type: "filter", path: "status" },
      { type: "filter", path: "scope.level" },
      { type: "filter", path: "scope.merchantId" },
      { type: "filter", path: "scope.customerId" },
    ],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureVectorIndex(db, log) {
  const memories = db.collection("memories");
  const wantDims = embeddingDims();
  const [existing] = await memories.listSearchIndexes(VECTOR_INDEX).toArray();
  const haveDims = existing?.latestDefinition?.fields?.find((f) => f.type === "vector")?.numDimensions;

  if (existing && haveDims !== wantDims) {
    log(`Vector index has ${haveDims} dims, need ${wantDims}; recreating`);
    await memories.dropSearchIndex(VECTOR_INDEX);
    while ((await memories.listSearchIndexes(VECTOR_INDEX).toArray()).length) await sleep(2000);
  }
  if (!existing || haveDims !== wantDims) {
    await memories.createSearchIndex({ name: VECTOR_INDEX, type: "vectorSearch", definition: vectorIndexDefinition() });
    log(`Creating vector index "${VECTOR_INDEX}" (${wantDims} dims)`);
  }

  for (let i = 0; i < 90; i++) {
    const [idx] = await memories.listSearchIndexes(VECTOR_INDEX).toArray();
    if (idx?.queryable && idx.status === "READY") return log(`Vector index "${VECTOR_INDEX}" is ready`);
    await sleep(2000);
  }
  throw new Error("Timed out waiting for the vector index to become queryable");
}

export async function ensureSchema(db, log = console.log) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const [name, validator] of Object.entries(COLLECTIONS)) {
    if (!existing.has(name)) {
      await db.createCollection(name, validator ? { validator, validationLevel: "strict", validationAction: "error" } : {});
    } else if (validator) {
      await db.command({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
    }
  }
  for (const [name, specs] of Object.entries(INDEXES)) {
    await db.collection(name).createIndexes(specs);
  }
  log("Collections, validators and indexes are in place");
  await ensureVectorIndex(db, log);
}
