import { createApp } from "./app.js";
import { migrateDatabase } from "./db.js";
import { env } from "./env.js";

await migrateDatabase();

const app = createApp();
app.listen(env.PORT, () => {
  console.log(`Backend listening on port ${env.PORT}`);
});

