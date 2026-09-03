import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { redirects, type RedirectRow } from "@/db/schema";
import { ApiError, notFound } from "./http";

/**
 * Permanent redirects from URLs this site used to serve.
 *
 * A slug change is one line of SQL; this is the other half of it. Without a
 * redirect, renaming a post silently 404s every inbound link, share and search
 * result that pointed at the old address — and the author never finds out,
 * because nothing errors.
 */

export type SerializedRedirect = {
  id: string;
  from_path: string;
  to_path: string;
  automatic: boolean;
  created_at: string;
};

function serialize(row: RedirectRow): SerializedRedirect {
  return {
    id: row.id,
    from_path: row.fromPath,
    to_path: row.toPath,
    automatic: row.automatic,
    created_at:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  };
}

/**
 * Normalises a path to the form stored and looked up: leading slash, no
 * trailing slash, no query or fragment, lowercase.
 *
 * Both sides of the comparison go through this, so `/Old-Post/?utm=x` and
 * `/old-post` are the same key.
 */
export function normalizePath(input: string): string {
  const withoutOrigin = input.replace(/^https?:\/\/[^/]+/i, "");
  const path = withoutOrigin.split(/[?#]/)[0].trim().toLowerCase();
  const withLeading = path.startsWith("/") ? path : `/${path}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, "") : "/";
}

/** The destination for a path, or null. */
export async function findRedirect(
  db: BlogDatabase,
  fromPath: string,
): Promise<string | null> {
  const [row] = await db
    .select({ toPath: redirects.toPath })
    .from(redirects)
    .where(eq(redirects.fromPath, normalizePath(fromPath)))
    .limit(1);
  return row?.toPath ?? null;
}

/**
 * Bounded, because this table grows on its own.
 *
 * Every slug change writes a row and nothing removes them, so an unbounded
 * select is a query whose cost rises with the age of the blog — and the whole
 * result was being sent to the browser in one go. 500 is far more than anyone
 * will scroll; the manager's own search is the way to find an old one.
 */
export async function listRedirects(
  db: BlogDatabase,
  limit = 500,
): Promise<SerializedRedirect[]> {
  const rows = await db
    .select()
    .from(redirects)
    .orderBy(desc(redirects.createdAt))
    .limit(limit);
  return rows.map(serialize);
}

/**
 * Records that `fromPath` now lives at `toPath`.
 *
 * Three things have to be true for the table to stay sane, and all of them are
 * enforced here rather than left to callers:
 *
 *  - **No self-redirect.** A rename back to a previous slug would otherwise
 *    leave `/a -> /a`, a loop the router would follow forever.
 *  - **Existing hops are retargeted.** Rename a -> b -> c and the row for `/a`
 *    is updated to point at `/c`, not left pointing at `/b`, which is now
 *    itself a redirect. One hop, always.
 *  - **The new location cannot also be a source.** If `/c` was previously
 *    redirected away, that row is dropped — the post lives there now.
 */
export async function recordSlugChange(
  db: BlogDatabase,
  fromPath: string,
  toPath: string,
  options: { automatic?: boolean } = {},
): Promise<void> {
  const from = normalizePath(fromPath);
  const to = normalizePath(toPath);
  if (from === to) return;

  await db.delete(redirects).where(eq(redirects.fromPath, to));

  await db
    .update(redirects)
    .set({ toPath: to })
    .where(and(eq(redirects.toPath, from), ne(redirects.fromPath, to)));

  await db
    .insert(redirects)
    .values({ fromPath: from, toPath: to, automatic: options.automatic ?? true })
    .onConflictDoUpdate({
      target: redirects.fromPath,
      set: { toPath: to, createdAt: sql`now()` },
    });
}

export async function createRedirect(
  db: BlogDatabase,
  fromPath: string,
  toPath: string,
): Promise<SerializedRedirect> {
  const from = normalizePath(fromPath);
  const to = toPath.startsWith("http") ? toPath : normalizePath(toPath);
  if (from === to) {
    throw new ApiError(422, "A redirect cannot point at itself");
  }

  const [row] = await db
    .insert(redirects)
    .values({ fromPath: from, toPath: to, automatic: false })
    .onConflictDoUpdate({
      target: redirects.fromPath,
      set: { toPath: to, automatic: false, createdAt: sql`now()` },
    })
    .returning();
  return serialize(row);
}

export async function deleteRedirect(db: BlogDatabase, id: string): Promise<void> {
  const deleted = await db
    .delete(redirects)
    .where(eq(redirects.id, id))
    .returning({ id: redirects.id });
  if (deleted.length === 0) throw notFound("Redirect");
}
