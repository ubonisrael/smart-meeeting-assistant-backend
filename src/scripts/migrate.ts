import { migrateDatabase, pool } from "../db.js";

await migrateDatabase();
await pool.end();
console.log("Database migrations applied");

