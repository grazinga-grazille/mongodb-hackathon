import { MongoClient, ServerApiVersion } from "mongodb";

const { MONGODB_USER, MONGODB_PASSWORD, MONGODB_HOST, MONGODB_DB, MONGODB_APP_NAME } = process.env;

if (!MONGODB_USER || !MONGODB_PASSWORD || !MONGODB_HOST) {
  throw new Error("Missing MONGODB_USER / MONGODB_PASSWORD / MONGODB_HOST in .env");
}
if (MONGODB_PASSWORD === "REPLACE_WITH_YOUR_PASSWORD") {
  throw new Error("Set MONGODB_PASSWORD in backend/.env before starting");
}

const uri =
  `mongodb+srv://${encodeURIComponent(MONGODB_USER)}:${encodeURIComponent(MONGODB_PASSWORD)}` +
  `@${MONGODB_HOST}/?retryWrites=true&w=majority`;

// One client per process; the driver pools connections internally.
const client = new MongoClient(uri, {
  appName: MONGODB_APP_NAME || "mongodb-hackathon",
  serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: true },
  maxPoolSize: 20,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
});

let db;

export async function connect() {
  if (db) return db;
  await client.connect();
  db = client.db(MONGODB_DB || "hackathon");
  await db.command({ ping: 1 });
  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not connected; call connect() first");
  return db;
}

/** The underlying client, needed for transactions (client.startSession()). */
export const getClient = () => client;

export async function close() {
  await client.close();
  db = undefined;
}
