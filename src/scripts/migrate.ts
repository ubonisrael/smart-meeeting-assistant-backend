import { migrateDatabase, pool } from "../config/database.js";

await migrateDatabase();
await pool.end();
console.log("Database migrations applied");
