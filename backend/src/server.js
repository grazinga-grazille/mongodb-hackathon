import express from "express";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { connect, getDb, close } from "./db.js";
import { embed } from "./lib/embeddings.js";
import { tools } from "./routes/tools.js";
import { admin } from "./routes/admin.js";
import { crud } from "./routes/crud.js";

const app = express();
app.use(express.json({ limit: "100kb" }));

app.get("/health", async (_req, res, next) => {
  try {
    await getDb().command({ ping: 1 });
    res.json({ ok: true, db: getDb().databaseName, embeddings: config.embedding.provider });
  } catch (err) {
    next(err);
  }
});

app.use("/tools", tools); // the voice agent's tools
app.use("/admin", admin); // dashboard + demo controls
if (config.enableGenericApi) app.use("/api", crud);
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)))); // dashboard at /

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 11000 ? 409 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Internal error" : err.message });
});

await connect();
await embed("warm up"); // load the embedding model before the first call, not during it
const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`Refund agent backend on http://localhost:${config.port} (db: ${getDb().databaseName}, embeddings: ${config.embedding.provider})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    server.close();
    await close();
    process.exit(0);
  });
}
