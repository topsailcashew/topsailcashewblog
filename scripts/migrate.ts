/**
 * Applies every pending migration in ./drizzle.
 *
 * Runs over plain TCP (node-postgres) rather than the Neon HTTP driver: DDL
 * wants a real transaction, and this only ever runs from a laptop or CI, never
 * from the Worker. Safe to re-run — drizzle tracks what it has applied in
 * `drizzle.__drizzle_migrations`.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createNodeDb } from "../src/db/node";
import { requireDatabaseUrl } from "./load-env";

async function main() {
  const url = requireDatabaseUrl();
  const { db, pool } = createNodeDb(url);
  const target = url.replace(/\/\/[^@]*@/, "//***@");

  console.log(`Applying migrations to ${target}`);
  try {
    await migrate(db as never, { migrationsFolder: "./drizzle" });
    console.log("Migrations up to date.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
