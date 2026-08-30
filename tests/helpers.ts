import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { setDbForTesting, type BlogDatabase } from "@/db/client";
import { createNodeDb } from "@/db/node";
import { loadEnv } from "../scripts/load-env";

loadEnv();

/**
 * Integration tests run against a real Postgres — the same SQL the Worker will
 * send to Neon. Point TEST_DATABASE_URL at a scratch database; it gets
 * truncated between tests.
 */
export const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

export const hasDatabase = connectionString !== "";

let handle: { db: BlogDatabase; pool: Pool } | null = null;
let restore: (() => void) | null = null;

export function db(): BlogDatabase {
  if (!handle) throw new Error("setupDatabase() has not run");
  return handle.db;
}

export async function setupDatabase(): Promise<void> {
  handle = createNodeDb(connectionString);
  await migrate(handle.db as never, { migrationsFolder: "./drizzle" });
  restore = setDbForTesting(handle.db);
}

/** Brings the schema up to date without leaving a handle open. */
export async function migrateOnce(): Promise<void> {
  const temporary = createNodeDb(connectionString);
  try {
    await migrate(temporary.db as never, { migrationsFolder: "./drizzle" });
  } finally {
    await temporary.pool.end();
  }
}

export async function teardownDatabase(): Promise<void> {
  restore?.();
  await handle?.pool.end();
  handle = null;
}

/**
 * Every table, so the suite is idempotent — leaving `series` behind made it
 * pass on a fresh database and fail on the second run, when slugs collided
 * with rows from the previous one.
 */
export async function resetTables(): Promise<void> {
  await db().execute(
    sql`truncate table comments, post_tags, posts, tags, media, series restart identity cascade`,
  );
}

/** Builds the `{ params }` object a Next dynamic route handler receives. */
export function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

export async function bodyOf<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
