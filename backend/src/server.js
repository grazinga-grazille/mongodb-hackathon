import express from "express";
import { ObjectId } from "mongodb";
import { connect, getDb, close } from "./db.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- helpers ----------
const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function collection(req) {
  const name = req.params.collection;
  if (!COLLECTION_RE.test(name)) {
    const err = new Error(`Invalid collection name "${name}"`);
    err.status = 400;
    throw err;
  }
  return getDb().collection(name);
}

// Accept either a 24-hex ObjectId or a plain string _id.
function idFilter(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? { _id: new ObjectId(id) } : { _id: id };
}

function parseJson(value, fallback) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    const err = new Error(`Invalid JSON in query parameter: ${value}`);
    err.status = 400;
    throw err;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- health / meta ----------
app.get("/health", wrap(async (_req, res) => {
  await getDb().command({ ping: 1 });
  res.json({ ok: true, db: getDb().databaseName });
}));

app.get("/api", wrap(async (_req, res) => {
  const cols = await getDb().listCollections({}, { nameOnly: true }).toArray();
  res.json(cols.map((c) => c.name).sort());
}));

// ---------- read ----------
// GET /api/:collection?filter={"status":"open"}&sort={"createdAt":-1}&projection={"name":1}&limit=20&skip=0
app.get("/api/:collection", wrap(async (req, res) => {
  const filter = parseJson(req.query.filter, {});
  const sort = parseJson(req.query.sort, { _id: -1 });
  const projection = parseJson(req.query.projection, undefined);
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const skip = Math.max(Number(req.query.skip) || 0, 0);

  const docs = await collection(req)
    .find(filter, { projection })
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .toArray();
  res.json(docs);
}));

app.get("/api/:collection/count", wrap(async (req, res) => {
  const filter = parseJson(req.query.filter, {});
  res.json({ count: await collection(req).countDocuments(filter) });
}));

app.get("/api/:collection/indexes", wrap(async (req, res) => {
  res.json(await collection(req).indexes());
}));

app.get("/api/:collection/:id", wrap(async (req, res) => {
  const doc = await collection(req).findOne(idFilter(req.params.id));
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.json(doc);
}));

// ---------- write ----------
// POST /api/:collection  body: {...}  or  [{...}, {...}]
app.post("/api/:collection", wrap(async (req, res) => {
  const col = collection(req);
  const now = new Date();
  if (Array.isArray(req.body)) {
    if (req.body.length === 0) return res.status(400).json({ error: "Empty array" });
    const docs = req.body.map((d) => ({ createdAt: now, updatedAt: now, ...d }));
    const result = await col.insertMany(docs);
    return res.status(201).json({ insertedCount: result.insertedCount, insertedIds: Object.values(result.insertedIds) });
  }
  const doc = { createdAt: now, updatedAt: now, ...req.body };
  const result = await col.insertOne(doc);
  res.status(201).json({ _id: result.insertedId, ...doc });
}));

// PATCH /api/:collection/:id  body: fields to $set, or an update doc with operators ({"$inc": {...}})
app.patch("/api/:collection/:id", wrap(async (req, res) => {
  const body = req.body ?? {};
  const hasOperators = Object.keys(body).some((k) => k.startsWith("$"));
  const update = hasOperators
    ? { ...body, $set: { ...(body.$set || {}), updatedAt: new Date() } }
    : { $set: { ...body, updatedAt: new Date() } };
  delete update.$set._id;

  const doc = await collection(req).findOneAndUpdate(idFilter(req.params.id), update, { returnDocument: "after" });
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.json(doc);
}));

// PUT /api/:collection/:id  body: full replacement document (upserts)
app.put("/api/:collection/:id", wrap(async (req, res) => {
  const { _id, ...rest } = req.body ?? {};
  const doc = await collection(req).findOneAndReplace(
    idFilter(req.params.id),
    { ...rest, updatedAt: new Date() },
    { returnDocument: "after", upsert: true },
  );
  res.json(doc);
}));

// PATCH /api/:collection  body: { "filter": {...}, "update": {...} }  -> updateMany
app.patch("/api/:collection", wrap(async (req, res) => {
  const { filter, update } = req.body ?? {};
  if (!filter || !update) return res.status(400).json({ error: "Body must include filter and update" });
  const result = await collection(req).updateMany(filter, update);
  res.json({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
}));

// ---------- delete ----------
// Must be registered before DELETE /:id so "_drop" isn't treated as an id.
app.delete("/api/:collection/_drop", wrap(async (req, res) => {
  const dropped = await collection(req).drop().catch((e) => (e.codeName === "NamespaceNotFound" ? false : Promise.reject(e)));
  res.json({ dropped });
}));

app.delete("/api/:collection/:id", wrap(async (req, res) => {
  const result = await collection(req).deleteOne(idFilter(req.params.id));
  if (result.deletedCount === 0) return res.status(404).json({ error: "Not found" });
  res.json({ deletedCount: result.deletedCount });
}));

// DELETE /api/:collection  body: { "filter": {...} }  -> deleteMany (empty filter refused)
app.delete("/api/:collection", wrap(async (req, res) => {
  const filter = req.body?.filter;
  if (!filter || Object.keys(filter).length === 0) {
    return res.status(400).json({ error: "Provide a non-empty filter; use DELETE /api/:collection/_drop to drop" });
  }
  const result = await collection(req).deleteMany(filter);
  res.json({ deletedCount: result.deletedCount });
}));

// ---------- other operations ----------
// POST /api/:collection/aggregate  body: [ pipeline stages ]
app.post("/api/:collection/aggregate", wrap(async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Body must be a pipeline array" });
  res.json(await collection(req).aggregate(req.body).toArray());
}));

// POST /api/:collection/indexes  body: { "keys": {"email": 1}, "options": {"unique": true} }
app.post("/api/:collection/indexes", wrap(async (req, res) => {
  const { keys, options } = req.body ?? {};
  if (!keys) return res.status(400).json({ error: "Body must include keys" });
  const name = await collection(req).createIndex(keys, options || {});
  res.status(201).json({ name });
}));

app.delete("/api/:collection/indexes/:name", wrap(async (req, res) => {
  await collection(req).dropIndex(req.params.name);
  res.json({ dropped: req.params.name });
}));

// ---------- errors ----------
app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 11000 ? 409 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

// ---------- start ----------
const port = Number(process.env.PORT) || 3000;
await connect();
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`API listening on http://localhost:${port} (db: ${getDb().databaseName})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    server.close();
    await close();
    process.exit(0);
  });
}
