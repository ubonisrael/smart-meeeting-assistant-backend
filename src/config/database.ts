import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { env } from "./env.js";

export const pool = new Pool({
  connectionString: env.DATABASE_URL
});

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationId = "001_init";
  const existing = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [migrationId]);
  if (existing.rowCount) {
    return;
  }

  const filePath = path.join(process.cwd(), "migrations", "001_init.sql");
  const sql = await readFile(filePath, "utf8");
  await withTransaction(async (client) => {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migrationId]);
  });
}

