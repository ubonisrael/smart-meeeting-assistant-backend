import { createApp } from "./app.js";
import { migrateDatabase } from "./config/database.js";
import { env } from "./config/env.js";

await migrateDatabase();

const app = createApp();
app.listen(env.PORT, () => {
  console.log(`Backend listening on port ${env.PORT}`);
});
