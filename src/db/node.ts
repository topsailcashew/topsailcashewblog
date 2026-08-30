/**
 * Node-only database handle (node-postgres over TCP).
 *
 * Used by the migration runner and the integration tests. Never imported by
 * anything under `src/app`, so it stays out of the Workers bundle. Works
 * against Neon too — Neon speaks the normal Postgres wire protocol on 5432.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { BlogDatabase } from "./client";
import { schema } from "./schema";

export function createNodeDb(connectionString: string): {
  db: BlogDatabase;
  pool: Pool;
} {
  const pool = new Pool({
    connectionString,
    // Neon requires TLS; a local socket/localhost cluster generally has none.
    ssl: /neon\.tech|sslmode=require/.test(connectionString)
      ? { rejectUnauthorized: true }
      : undefined,
    max: 4,
  });
  const db = drizzle(pool, { schema }) as unknown as BlogDatabase;
  return { db, pool };
}
