import { and, eq, like, ne, or } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { pages, posts } from "@/db/schema";

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
 * Slugs the router owns. A post or page taking one of these would be shadowed
 * by the real route and never render.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "articles",
  "media",
  "og",
  "page",
  "preview",
  "robots.txt",
  "rss.xml",
  "search",
  "series",
  "sitemap.xml",
  "tag",
]);

/**
 * Top-level paths served by a file route, which `/[slug]` must not prerender.
 *
 * Distinct from `RESERVED_SLUGS`: those are refused on create, while these are
 * slugs a page legitimately *has* — `about` and `newsletter` both name a real
 * page row whose prose a bespoke route renders. Reserving them would make the
 * admin unable to save the very page it describes.
 */
export const FILE_ROUTE_SLUGS: ReadonlySet<string> = new Set(["about", "newsletter"]);

/**
 * Pick the first free slug in the series `base`, `base-2`, `base-3`, ...
 *
 * Posts and pages are checked together. They share the `/[slug]` route, and
 * that route resolves posts first — so a post allowed to take a page's slug
 * would not collide at the database level, it would just make the page
 * unreachable. Treating the two namespaces as one keeps that from happening.
 *
 * `excludeId` lets a row keep its own slug on update instead of colliding
 * with itself. This is a best-effort check: the unique index is the real
 * guarantee, and callers retry on violation (see `withUniqueSlug`).
 */
export async function findAvailableSlug(
  db: BlogDatabase,
  base: string,
  excludeId?: string,
): Promise<string> {
  // `base` is already slugified, so it contains no LIKE metacharacters.
  const postFilter = or(eq(posts.slug, base), like(posts.slug, `${base}-%`));
  const pageFilter = or(eq(pages.slug, base), like(pages.slug, `${base}-%`));

  const [postRows, pageRows] = await Promise.all([
    db
      .select({ slug: posts.slug })
      .from(posts)
      .where(excludeId ? and(postFilter, ne(posts.id, excludeId)) : postFilter),
    db
      .select({ slug: pages.slug })
      .from(pages)
      .where(excludeId ? and(pageFilter, ne(pages.id, excludeId)) : pageFilter),
  ]);

  const taken = new Set([...postRows, ...pageRows].map((row) => row.slug));
  // A derived slug that lands on a router-owned name is bumped to `-2`.
  if (RESERVED_SLUGS.has(base)) taken.add(base);
  return firstFreeSlug(base, taken);
}


/** `base`, else the first free `base-2`, `base-3`, … Shared with series slugs. */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>): string {
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
