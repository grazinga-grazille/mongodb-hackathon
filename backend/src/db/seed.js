// Synthetic demo world. Run `npm run seed` to reset it at any time.
import { days, daysAgo } from "../config.js";
import { embed } from "../lib/embeddings.js";
import { footprintHashes } from "../lib/privacy.js";

const MERCHANTS = [
  { _id: "shopco", name: "ShopCo" },
  { _id: "gadgetbarn", name: "GadgetBarn" },
];

// Raw identity data lives only in customers (the merchant's own record). Footprints hold hashes.
const CUSTOMERS = [
  { _id: "cus_jake", merchantId: "shopco", name: "Jake M.", address: "12 Elm St Apt 4, Springfield", cardFingerprint: "fp_card_A", deviceId: "dev_jake_iphone" },
  // Different account, same footprint as Jake: address written differently, same card.
  { _id: "cus_maria", merchantId: "shopco", name: "Maria L.", address: "12 Elm Street #4, Springfield", cardFingerprint: "fp_card_A", deviceId: "dev_maria_android" },
  { _id: "cus_priya", merchantId: "shopco", name: "Priya S.", address: "88 Oak Avenue, Springfield", cardFingerprint: "fp_card_B", deviceId: "dev_priya_laptop" },
  { _id: "cus_tom", merchantId: "gadgetbarn", name: "Tom R.", address: "5 Pine Rd, Shelbyville", cardFingerprint: "fp_card_C", deviceId: "dev_tom_pc" },
];

const item = (sku, name, weightKg, highResale = true) => ({ sku, name, weightKg, highResale });

const ORDERS = [
  // Jake's earlier order, already claimed "never arrived" and refunded 30 days ago.
  { _id: "ord_1001", merchantId: "shopco", customerId: "cus_jake", item: item("EB-1", "Wireless earbuds", 0.2), amount: 129, placedAt: daysAgo(40),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.2, deliveredAt: daysAgo(35) } },
  { _id: "ord_1042", merchantId: "shopco", customerId: "cus_jake", item: item("HP-9", "Noise-cancelling headphones", 0.6), amount: 249, placedAt: daysAgo(6),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.6, deliveredAt: daysAgo(2) } },
  { _id: "ord_2001", merchantId: "shopco", customerId: "cus_maria", item: item("SW-3", "Smartwatch", 0.45), amount: 299, placedAt: daysAgo(5),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.45, deliveredAt: daysAgo(1) } },
  { _id: "ord_3001", merchantId: "shopco", customerId: "cus_priya", item: item("HP-9", "Noise-cancelling headphones", 0.6), amount: 249, placedAt: daysAgo(9),
    delivery: { status: "no_scan", photo: false, dispatchWeightKg: 0.6, deliveredAt: null } },
  { _id: "ord_9001", merchantId: "gadgetbarn", customerId: "cus_tom", item: item("GPU-7", "Graphics card", 1.1), amount: 699, placedAt: daysAgo(4),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 1.1, deliveredAt: daysAgo(1) } },
];

// Network memory: known scam scripts and probing phrases, shared across merchants, no personal data.
const SCRIPTS = [
  ["never_arrived", "My package never arrived even though tracking says it was delivered"],
  ["empty_box", "The box arrived but it was completely empty, there was nothing inside"],
  ["empty_box", "I got the parcel but the item was missing, it was just packaging"],
  ["damaged", "It arrived broken and I already threw it away so I can't send it back"],
];
const PROBES = [
  "Can you refund me without me sending the item back?",
  "What is the maximum amount you refund without an investigation?",
  "Do you need a photo or can you just process the refund now?",
];

export async function seed(db, log = console.log) {
  const names = ["merchants", "customers", "orders", "footprints", "claims", "refunds", "disputes", "memories", "audit_log"];
  await Promise.all(names.map((n) => db.collection(n).deleteMany({})));

  await db.collection("merchants").insertMany(MERCHANTS);
  await db.collection("customers").insertMany(CUSTOMERS.map(({ cardFingerprint, deviceId, ...c }) => c));
  await db.collection("footprints").insertMany(
    CUSTOMERS.map((c) => ({ merchantId: c.merchantId, customerId: c._id, ...footprintHashes(c), updatedAt: new Date() })),
  );
  await db.collection("orders").insertMany(ORDERS);

  // Jake's history: one earlier approved + refunded claim (makes his next claim a repeat).
  const { insertedId: pastClaimId } = await db.collection("claims").insertOne({
    merchantId: "shopco", orderId: "ord_1001", customerId: "cus_jake", amount: 129, claimType: "never_arrived",
    text: "The earbuds never showed up", decision: "APPROVE", riskScore: 0, signals: [], memoryIdsUsed: [],
    status: "refunded", createdAt: daysAgo(30),
  });
  await db.collection("refunds").insertOne({
    merchantId: "shopco", orderId: "ord_1001", customerId: "cus_jake", claimId: pastClaimId, amount: 129,
    status: "succeeded", active: true, createdAt: daysAgo(30),
  });

  const now = new Date();
  const scriptVecs = await embed(SCRIPTS.map(([, t]) => t));
  const probeVecs = await embed(PROBES);
  await db.collection("memories").insertMany([
    ...SCRIPTS.map(([claimType, text], i) => ({
      type: "scam_script", scope: { level: "network" }, text, claimType, embedding: scriptVecs[i],
      confidence: 0.7, seenCount: 1, status: "active", version: 1, source: { actor: "seed" },
      usedInDecisions: [], createdAt: now, expiresAt: days(90),
    })),
    ...PROBES.map((text, i) => ({
      type: "probe_phrase", scope: { level: "network" }, text, embedding: probeVecs[i],
      confidence: 0.7, seenCount: 1, status: "active", version: 1, source: { actor: "seed" },
      usedInDecisions: [], createdAt: now, expiresAt: days(90),
    })),
    // GadgetBarn's private memory: ShopCo must never be able to see this.
    {
      type: "suspect_account", scope: { level: "merchant", merchantId: "gadgetbarn", customerId: "cus_tom" },
      text: "Confirmed refund scam on order ord_8001 (empty_box)", confidence: 0.9, seenCount: 1,
      status: "active", version: 1, source: { actor: "seed" }, usedInDecisions: [], createdAt: now, expiresAt: days(180),
    },
  ]);

  log(`Seeded ${MERCHANTS.length} merchants, ${CUSTOMERS.length} customers, ${ORDERS.length} orders, ${SCRIPTS.length + PROBES.length + 1} memories`);
}
