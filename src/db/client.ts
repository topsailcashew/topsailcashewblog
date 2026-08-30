import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { schema } from "./schema";

/**
 * The database shape the application codes against.
 *
 * Deliberately the driver-agnostic `PgDatabase` base rather than the concrete
 * `NeonHttpDatabase`, so the same query layer runs against the Neon HTTP driver
 * (Workers runtime) and node-postgres (migrations + tests) without change.
 */
export type BlogDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: BlogDatabase | null = null;
let override: BlogDatabase | null = null;

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and add your Neon connection string.",
    );
  }
  return url;
}

/**
 * The app's database handle. Neon's HTTP driver is used because it is a plain
 * `fetch` call per query — no TCP sockets, no connection pool to keep warm,
 * which is what the Workers runtime can actually support.
 */
export function getDb(): BlogDatabase {
  if (override) return override;
  if (cached) return cached;

  // By default the driver derives its endpoint from the connection string
  // host. NEON_FETCH_ENDPOINT redirects it at a local SQL-over-HTTP proxy
  // (Neon Local, or the shim in tests/) so the app can run against a plain
  // Postgres. Unset in production.
  const fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
  if (fetchEndpoint) neonConfig.fetchEndpoint = fetchEndpoint;

  cached = drizzle(neon(getDatabaseUrl()), {
    schema,
  }) as unknown as BlogDatabase;
  return cached;
}

/** Test seam: point the app at a node-postgres handle. Returns a reset fn. */
export function setDbForTesting(db: BlogDatabase | null): () => void {
  const previous = override;
  override = db;
  return () => {
    override = previous;
  };
}
