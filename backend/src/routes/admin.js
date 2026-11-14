// Demo and dashboard endpoints: state, live events, simulated bank disputes, memory controls.
// Local-only (server binds to 127.0.0.1). Would need analyst auth before any deployment.
import { Router } from "express";
import { getDb } from "../db.js";
import { httpError, requireString, wrap } from "../lib/http.js";
import { embed } from "../lib/embeddings.js";
import { audit } from "../lib/audit.js";
import { readableBy, searchMemories, correctMemory, expireNow } from "../services/memory.js";
import { seed } from "../db/seed.js";
import { requireMerchant } from "./tools.js";

export const admin = Router();

// Live updates: a change stream on the database pushes "something changed" to the dashboard.
admin.get("/events", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const stream = getDb().watch([{ $match: { "ns.coll": { $in: ["claims", "memories", "refunds", "disputes", "footprints", "calls"] } } }]);
  stream.on("change", (c) => res.write(`data: ${JSON.stringify({ coll: c.ns.coll, op: c.operationType })}\n\n`));
  stream.on("error", () => res.end());
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); stream.close(); });
});

admin.post("/reset", wrap(async (_req, res) => {
  await seed(getDb(), () => {});
  res.json({ ok: true });
}));

admin.use(requireMerchant);

admin.get("/state", wrap(async (req, res) => {
  const db = getDb();
  const m = req.merchantId;
  const [orders, customers, claims, refunds, disputes, memories, calls] = await Promise.all([
    db.collection("orders").find({ merchantId: m }).sort({ _id: 1 }).toArray(),
    db.collection("customers").find({ merchantId: m }, { projection: { name: 1 } }).toArray(),
    db.collection("claims").find({ merchantId: m }).sort({ createdAt: -1 }).limit(25).toArray(),
    db.collection("refunds").find({ merchantId: m, active: true }).sort({ createdAt: -1 }).toArray(),
    db.collection("disputes").find({ merchantId: m }).sort({ createdAt: -1 }).toArray(),
    db.collection("memories").find(readableBy(m), { projection: { embedding: 0 } }).sort({ createdAt: -1 }).limit(50).toArray(),
    db.collection("calls").find({ merchantId: m }).sort({ createdAt: -1 }).limit(10).toArray(),
  ]);
  const stopped = claims.filter((c) => ["escalated", "declined", "confirmed_scam"].includes(c.status));
  res.json({
    merchantId: m, orders, customers, claims, refunds, disputes, memories, calls,
    stats: {
      refunded: refunds.reduce((s, r) => s + r.amount, 0),
      stopped: stopped.reduce((s, c) => s + c.amount, 0),
      claims: claims.length,
    },
  });
}));

// Governance demo: a raw semantic search that still only returns what this merchant may read.
admin.get("/memories/search", wrap(async (req, res) => {
  const q = requireString(req.query.q, "q", { max: 500 });
  const vector = await embed(q, "query");
  res.json(await searchMemories(getDb(), {
    merchantId: req.merchantId, vector, limit: 5,
    types: ["scam_script", "probe_phrase", "suspect_account", "cleared_customer"],
  }));
}));

admin.post("/memories/:id/correct", wrap(async (req, res) => {
  res.json(await correctMemory(getDb(), {
    merchantId: req.merchantId, memoryId: req.params.id, text: requireString(req.body?.text, "text"), actor: "analyst",
  }));
}));

admin.post("/memories/:id/expire", wrap(async (req, res) => {
  res.json(await expireNow(getDb(), { merchantId: req.merchantId, memoryId: req.params.id }));
}));

// Simulates the customer's bank opening a chargeback (in production: processor webhook).
admin.post("/disputes", wrap(async (req, res) => {
  const db = getDb();
  const orderId = requireString(req.body?.orderId, "orderId", { max: 64 });
  const order = await db.collection("orders").findOne({ _id: orderId, merchantId: req.merchantId });
  if (!order) throw httpError(404, "Order not found");
  const dispute = { merchantId: req.merchantId, orderId, customerId: order.customerId, amount: order.amount, status: "open", reason: "item_not_received", createdAt: new Date() };
  await db.collection("disputes").insertOne(dispute);
  await audit(db, "dispute.opened", { merchantId: req.merchantId, orderId });
  res.status(201).json(dispute);
}));
