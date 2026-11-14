// `npm run setup` -> schema only. `npm run seed` -> schema + reset demo data.
import { connect, close } from "../db.js";
import { ensureSchema } from "./schema.js";
import { seed } from "./seed.js";

const command = process.argv[2];
try {
  const db = await connect();
  await ensureSchema(db);
  if (command === "seed") await seed(db);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await close();
}
