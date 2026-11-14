// Generic collection CRUD from the first iteration. Disabled by default because it bypasses
// every governance rule; enable with ENABLE_GENERIC_API=true for local debugging only.
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { httpError, wrap } from "../lib/http.js";

const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const col = (req) => {
  if (!COLLECTION_RE.test(req.params.collection)) throw httpError(400, "Invalid collection name");
  return getDb().collection(req.params.collection);
};
const idFilter = (id) => (ObjectId.isValid(id) && String(new ObjectId(id)) === id ? { _id: new ObjectId(id) } : { _id: id });
const json = (v, d) => {
  if (v === undefined) return d;
  try { return JSON.parse(v); } catch { throw httpError(400, `Invalid JSON: ${v}`); }
};

export const crud = Router();

crud.get("/", wrap(async (_req, res) => {
  res.json((await getDb().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort());
}));
crud.get("/:collection", wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json(await col(req).find(json(req.query.filter, {}), { projection: json(req.query.projection) })
    .sort(json(req.query.sort, { _id: -1 })).limit(limit).toArray());
}));
crud.get("/:collection/:id", wrap(async (req, res) => {
  const doc = await col(req).findOne(idFilter(req.params.id));
  if (!doc) throw httpError(404, "Not found");
  res.json(doc);
}));
crud.post("/:collection", wrap(async (req, res) => {
  const r = await col(req).insertOne({ createdAt: new Date(), ...req.body });
  res.status(201).json({ _id: r.insertedId });
}));
crud.delete("/:collection/:id", wrap(async (req, res) => {
  res.json({ deletedCount: (await col(req).deleteOne(idFilter(req.params.id))).deletedCount });
}));
