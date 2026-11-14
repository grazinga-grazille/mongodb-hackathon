import { connect, close } from "./db.js";

try {
  const db = await connect();
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  console.log(`Connected to database "${db.databaseName}".`);
  console.log("Collections:", collections.map((c) => c.name));
} catch (err) {
  console.error("Connection failed:", err.message);
  process.exitCode = 1;
} finally {
  await close();
}
