// Synthetic demo world. Run `npm run seed` to reset it at any time.
import { days, daysAgo } from "../config.js";
import { embed } from "../lib/embeddings.js";
import { footprintHashes } from "../lib/privacy.js";

const MERCHANTS = [
  { _id: "shopco", name: "ShopCo" },
  { _id: "gadgetbarn", name: "GadgetBarn" },
  { _id: "electro_depot", name: "ElectroDepot" },
];

// Raw identity data lives only in customers (the merchant's own record). Footprints hold hashes.
const CUSTOMERS = [
  // ---- core demo personas ----
  { _id: "cus_jake", merchantId: "shopco", name: "Jake M.", address: "12 Elm St Apt 4, Springfield", cardFingerprint: "fp_card_A", deviceId: "dev_jake_iphone" },
  // Different account, same footprint as Jake: address written differently, same card.
  { _id: "cus_maria", merchantId: "shopco", name: "Maria L.", address: "12 Elm Street #4, Springfield", cardFingerprint: "fp_card_A", deviceId: "dev_maria_android" },
  { _id: "cus_priya", merchantId: "shopco", name: "Priya S.", address: "88 Oak Avenue, Springfield", cardFingerprint: "fp_card_B", deviceId: "dev_priya_laptop" },
  { _id: "cus_tom", merchantId: "gadgetbarn", name: "Tom R.", address: "5 Pine Rd, Shelbyville", cardFingerprint: "fp_card_C", deviceId: "dev_tom_pc" },

  // ---- scammer ring: Danny + Emma (shopco), Felix (gadgetbarn) ----
  // "33 Maple Ave Unit 1" and "33 Maple Avenue Unit 1" normalise to the same addressHash.
  // Felix (gadgetbarn) shares Danny's address AND card — links him cross-merchant via script memory.
  { _id: "cus_danny", merchantId: "shopco", name: "Danny K.", address: "33 Maple Ave Unit 1, Springfield", cardFingerprint: "fp_card_D", deviceId: "dev_danny_iphone" },
  { _id: "cus_emma", merchantId: "shopco", name: "Emma V.", address: "33 Maple Avenue Unit 1, Springfield", cardFingerprint: "fp_card_D", deviceId: "dev_emma_android" },
  { _id: "cus_felix", merchantId: "gadgetbarn", name: "Felix O.", address: "33 Maple Ave Unit 1, Springfield", cardFingerprint: "fp_card_D", deviceId: "dev_felix_pc" },

  // ---- serial claimer: Sam ----
  // Two approved claims in the past 90 days. Current call fires repeat_claims.
  { _id: "cus_sam", merchantId: "shopco", name: "Sam W.", address: "77 Cedar Blvd, Springfield", cardFingerprint: "fp_card_E", deviceId: "dev_sam_tablet" },

  // ---- honest customer: Nina ----
  // "12 Elm Street Apartment 4" normalises to the same addressHash as Jake.
  // Gets escalated on first call (linked to Jake); analyst clears her; next call goes through.
  { _id: "cus_nina", merchantId: "shopco", name: "Nina P.", address: "12 Elm Street Apartment 4, Springfield", cardFingerprint: "fp_card_F", deviceId: "dev_nina_laptop" },

  // ---- Simple voice demo: Alex (shopco) ----
  // Call 1 (order 1111): no delivery scan, first claim -> refunded.
  // Call 2 (order 2222): delivered with photo + second claim today -> sent to a specialist.
  { _id: "cus_alex", merchantId: "shopco", name: "Alex R.", address: "41 Birch Lane, Springfield", cardFingerprint: "fp_card_H", deviceId: "dev_alex_iphone" },
  // Two-caller demo: Chris is a new name, but the same address (written "Ln") and the same card as Alex.
  // His order looks innocent (no delivery scan); only the remembered story + footprint catch him.
  { _id: "cus_chris", merchantId: "shopco", name: "Chris B.", address: "41 Birch Ln, Springfield", cardFingerprint: "fp_card_H", deviceId: "dev_chris_android" },

  // ---- ElectroDepot ----
  { _id: "cus_lena", merchantId: "electro_depot", name: "Lena T.", address: "9 Spruce Court, Shelbyville", cardFingerprint: "fp_card_G", deviceId: "dev_lena_iphone" },
];

const item = (sku, name, weightKg, highResale = true) => ({ sku, name, weightKg, highResale });

const ORDERS = [
  // ---- Jake (shopco) ----
  // ord_1001: earlier order, claimed "never arrived", already refunded 30 days ago → repeat_claims on next call.
  { _id: "ord_1001", merchantId: "shopco", customerId: "cus_jake", item: item("EB-1", "Wireless earbuds", 0.2), amount: 129, placedAt: daysAgo(40),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.2, deliveredAt: daysAgo(35) } },
  { _id: "ord_1042", merchantId: "shopco", customerId: "cus_jake", item: item("HP-9", "Noise-cancelling headphones", 0.6), amount: 249, placedAt: daysAgo(6),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.6, deliveredAt: daysAgo(2) } },

  // ---- Maria (shopco) ----
  { _id: "ord_2001", merchantId: "shopco", customerId: "cus_maria", item: item("SW-3", "Smartwatch", 0.45), amount: 299, placedAt: daysAgo(5),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.45, deliveredAt: daysAgo(1) } },

  // ---- Priya (shopco) — honest, no delivery scan ----
  { _id: "ord_3001", merchantId: "shopco", customerId: "cus_priya", item: item("HP-9", "Noise-cancelling headphones", 0.6), amount: 249, placedAt: daysAgo(9),
    delivery: { status: "no_scan", photo: false, dispatchWeightKg: 0.6, deliveredAt: null } },

  // ---- Tom (gadgetbarn) — already flagged suspect_account ----
  { _id: "ord_9001", merchantId: "gadgetbarn", customerId: "cus_tom", item: item("GPU-7", "Graphics card", 1.1), amount: 699, placedAt: daysAgo(4),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 1.1, deliveredAt: daysAgo(1) } },

  // ---- Scammer ring ----
  // Danny: delivered with photo + weight match. Any "empty box" claim contradicts the facts.
  { _id: "ord_4001", merchantId: "shopco", customerId: "cus_danny", item: item("BT-5", "Bluetooth speaker", 0.55), amount: 189, placedAt: daysAgo(5),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.55, deliveredAt: daysAgo(2) } },
  // Emma: same situation. Footprint links her to Danny (escalated) before her claim is even checked.
  { _id: "ord_4002", merchantId: "shopco", customerId: "cus_emma", item: item("FT-2", "Fitness tracker", 0.12), amount: 149, placedAt: daysAgo(4),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.12, deliveredAt: daysAgo(1) } },
  // Felix (gadgetbarn): same address + card as Danny. After Danny is confirmed, the network script
  // memory catches Felix even though he is on a different merchant.
  { _id: "ord_7001", merchantId: "gadgetbarn", customerId: "cus_felix", item: item("GH-3", "Gaming headset", 0.4), amount: 219, placedAt: daysAgo(5),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.4, deliveredAt: daysAgo(2) } },

  // ---- Serial claimer Sam (shopco) ----
  // Two past approved claims within 90 days → current call triggers repeat_claims.
  { _id: "ord_5001", merchantId: "shopco", customerId: "cus_sam", item: item("EB-1", "Wireless earbuds", 0.2), amount: 79, placedAt: daysAgo(65),
    delivery: { status: "no_scan", photo: false, dispatchWeightKg: 0.2, deliveredAt: null } },
  { _id: "ord_5002", merchantId: "shopco", customerId: "cus_sam", item: item("CC-1", "Phone case", 0.05), amount: 29, placedAt: daysAgo(42),
    delivery: { status: "no_scan", photo: false, dispatchWeightKg: 0.05, deliveredAt: null } },
  { _id: "ord_5003", merchantId: "shopco", customerId: "cus_sam", item: item("KB-4", "Mechanical keyboard", 0.9), amount: 159, placedAt: daysAgo(7),
    delivery: { status: "no_scan", photo: false, dispatchWeightKg: 0.9, deliveredAt: null } },

  // ---- Nina (shopco) — honest, shares Jake's normalised address ----
  { _id: "ord_6001", merchantId: "shopco", customerId: "cus_nina", item: item("HP-9", "Noise-cancelling headphones", 0.6), amount: 249, placedAt: daysAgo(8),
    delivery: { status: "no_scan", photo: false, dispatchWeightKg: 0.6, deliveredAt: null } },

  // ---- Two-caller voice demo: "the box was empty" ----
  // Both parcels weighed far less than the headphones at dispatch, so the delivery facts support an
  // empty box for BOTH callers. Only memory (vector search on the story) + footprint catch caller 2.
  // Caller 1 — Alex, order 2058: first claim -> refunded.
  { _id: "ord_2058", merchantId: "shopco", customerId: "cus_alex", item: item("HP-9", "Noise-cancelling headphones", 0.6), amount: 249, placedAt: daysAgo(6),
    delivery: { status: "delivered", photo: false, dispatchWeightKg: 0.1, deliveredAt: daysAgo(2) } },
  // Caller 2 — Chris, order 3046: new name, same story -> flagged and sent to a specialist.
  { _id: "ord_3046", merchantId: "shopco", customerId: "cus_chris", item: item("HP-9", "Noise-cancelling headphones", 0.6), amount: 249, placedAt: daysAgo(5),
    delivery: { status: "delivered", photo: false, dispatchWeightKg: 0.1, deliveredAt: daysAgo(1) } },

  // ---- Lena (electro_depot) ----
  { _id: "ord_8002", merchantId: "electro_depot", customerId: "cus_lena", item: item("TB-1", "Tablet", 0.65), amount: 349, placedAt: daysAgo(5),
    delivery: { status: "delivered", photo: true, dispatchWeightKg: 0.65, deliveredAt: daysAgo(2) } },
];

// Network memory: known scam scripts and probing phrases, shared across all merchants, no personal data.
// Multiple phrasings per claim type give the vector index enough spread to catch reworded scripts.
const SCRIPTS = [
  // never_arrived — 5 phrasings
  ["never_arrived", "My package never arrived even though tracking says it was delivered"],
  ["never_arrived", "Tracking shows delivered but I haven't received anything at all"],
  ["never_arrived", "It says it was left at my door but there is nothing here"],
  ["never_arrived", "The delivery confirmation came through but the package never showed up"],
  ["never_arrived", "I checked everywhere and the parcel is nowhere to be found"],

  // empty_box — 5 phrasings
  ["empty_box", "The box arrived but it was completely empty, there was nothing inside"],
  ["empty_box", "I got the parcel but the item was missing, it was just packaging"],
  ["empty_box", "Someone must have opened it and taken the product out before it got to me"],
  ["empty_box", "The box was resealed but there was absolutely nothing inside when I opened it"],
  ["empty_box", "I received the outer packaging but the actual item was not in there"],

  // damaged — 3 phrasings
  ["damaged", "It arrived broken and I already threw it away so I can't send it back"],
  ["damaged", "The screen shattered in transit and it is completely unusable"],
  ["damaged", "It was smashed when it arrived, clearly dropped by the courier"],

  // wrong_item — 3 phrasings
  ["wrong_item", "I received the wrong item, this is not what I ordered at all"],
  ["wrong_item", "They sent me a completely different product, the wrong model entirely"],
  ["wrong_item", "The box had my order number on it but the contents were totally different"],
];

const PROBES = [
  "Can you refund me without me sending the item back?",
  "What is the maximum amount you refund without an investigation?",
  "Do you need a photo or can you just process the refund now?",
  "How long does the investigation usually take?",
  "Can I keep the item and get a refund at the same time?",
  "Do I need to file a police report for this?",
  "What is the quickest way to get the refund processed today?",
  "Can you just put the money straight back on my card?",
  "Is there a limit below which you just approve it automatically?",
  "Do I actually have to send the item back or do you just trust customers?",
  "How much proof do I need to provide before you approve this?",
  "Can you skip the investigation this time since I am a regular customer?",
  "What happens if I just go to my bank and open a dispute instead?",
];

export async function seed(db, log = console.log) {
  const names = ["merchants", "customers", "orders", "footprints", "claims", "refunds", "disputes", "memories", "calls", "audit_log"];
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

  // Sam's history: two approved claims within 90 days → triggers repeat_claims on her next call.
  const { insertedId: samClaim1 } = await db.collection("claims").insertOne({
    merchantId: "shopco", orderId: "ord_5001", customerId: "cus_sam", amount: 79, claimType: "never_arrived",
    text: "The earbuds never arrived", decision: "APPROVE", riskScore: 0, signals: [], memoryIdsUsed: [],
    status: "refunded", createdAt: daysAgo(60),
  });
  await db.collection("refunds").insertOne({
    merchantId: "shopco", orderId: "ord_5001", customerId: "cus_sam", claimId: samClaim1, amount: 79,
    status: "succeeded", active: true, createdAt: daysAgo(60),
  });
  const { insertedId: samClaim2 } = await db.collection("claims").insertOne({
    merchantId: "shopco", orderId: "ord_5002", customerId: "cus_sam", amount: 29, claimType: "never_arrived",
    text: "The phone case never turned up", decision: "APPROVE", riskScore: 0, signals: [], memoryIdsUsed: [],
    status: "refunded", createdAt: daysAgo(42),
  });
  await db.collection("refunds").insertOne({
    merchantId: "shopco", orderId: "ord_5002", customerId: "cus_sam", claimId: samClaim2, amount: 29,
    status: "succeeded", active: true, createdAt: daysAgo(42),
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
