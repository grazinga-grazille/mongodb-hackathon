import express from "express";
import { config } from "./config.js";
import { connect, getDb, close } from "./db.js";
import { embed } from "./lib/embeddings.js";
import { tools } from "./routes/tools.js";
import { admin } from "./routes/admin.js";
import { crud } from "./routes/crud.js";
import { voice } from "./routes/voice.js";

const app = express();

// CORS: only the frontend origins in CORS_ORIGINS may call the API from a browser.
// (In dev the frontend uses Vite's proxy, which is same-origin and needs no CORS.)
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4173").split(",").map((s) => s.trim()).filter(Boolean),
);
app.use((req, res, next) => {
  const origin = req.get("origin");
  const allowed = origin && allowedOrigins.has(origin);
  if (allowed) {
    res.set({
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type, x-merchant-id",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "Origin",
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
  next();
});

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
app.use("/voice", voice); // signed URLs + call transcripts
if (config.enableGenericApi) app.use("/api", crud);
app.get("/", (_req, res) =>
  res.json({ service: "refund-guard-backend", frontend: "see the mongodb-hackathon-frontend repo (http://localhost:5173)" }),
);

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
