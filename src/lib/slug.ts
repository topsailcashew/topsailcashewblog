import { and, eq, like, ne, or } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { posts } from "@/db/schema";

/** Longest slug stem we will generate before a uniqueness suffix is added. */
const MAX_SLUG_LENGTH = 80;
const FALLBACK_SLUG = "post";

/**
 * Title -> URL slug. Unicode is folded to ASCII where possible ("Café" ->
 * "cafe") so slugs stay typeable; anything left over is dropped.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    // Strip combining marks left behind by the decomposition.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  return slug || FALLBACK_SLUG;
}

/**
 * Pick the first free slug in the series `base`, `base-2`, `base-3`, ...
 *
 * `excludeId` lets a post keep its own slug on update instead of colliding
 * with itself. This is a best-effort check: the unique index is the real
 * guarantee, and callers retry on violation (see `insertWithUniqueSlug`).
 */
export async function findAvailableSlug(
  db: BlogDatabase,
  base: string,
  excludeId?: string,
): Promise<string> {
  // `base` is already slugified, so it contains no LIKE metacharacters.
  const collisionFilter = or(
    eq(posts.slug, base),
    like(posts.slug, `${base}-%`),
  );

  const rows = await db
    .select({ slug: posts.slug })
    .from(posts)
    .where(excludeId ? and(collisionFilter, ne(posts.id, excludeId)) : collisionFilter);

  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps driver failures in a `DrizzleQueryError`, and the Neon HTTP
 * driver can nest the original again under `sourceError`, so the SQLSTATE can
 * sit a couple of levels down. Walk the chain rather than trusting the top.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== "object") return false;
    const candidate = current as {
      code?: unknown;
      cause?: unknown;
      sourceError?: unknown;
    };
    if (candidate.code === UNIQUE_VIOLATION) return true;
    current = candidate.cause ?? candidate.sourceError;
  }
  return false;
}

/**
 * Run `attempt` against successive free slugs, retrying when a concurrent
 * writer takes the slug between our lookup and our insert.
 */
export async function withUniqueSlug<T>(
  db: BlogDatabase,
  base: string,
  attempt: (slug: string) => Promise<T>,
  options: { excludeId?: string; maxAttempts?: number } = {},
): Promise<T> {
  const { excludeId, maxAttempts = 5 } = options;
  let lastError: unknown;

  for (let i = 0; i < maxAttempts; i += 1) {
    const slug = await findAvailableSlug(db, base, excludeId);
    try {
      return await attempt(slug);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

/** True when the slug is in the shape our routes accept as a manual override. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120;
}

export { MAX_SLUG_LENGTH };
