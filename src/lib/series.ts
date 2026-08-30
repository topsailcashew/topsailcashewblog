import { and, asc, count, eq, like, ne, or, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { posts, series, type SeriesRow } from "@/db/schema";
import { ApiError, notFound } from "./http";
import { firstFreeSlug, isUniqueViolation, slugify } from "./slug";

export type SerializedSeries = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  created_at: string;
  post_count: number;
};

export function serializeSeries(row: SeriesRow, postCount = 0): SerializedSeries {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    description: row.description,
    created_at:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
    post_count: postCount,
  };
}

/** All series with how many *published* posts each carries. */
export async function listSeries(db: BlogDatabase): Promise<SerializedSeries[]> {
  const rows = await db
    .select({
      row: series,
      published: sql<number>`count(${posts.id}) filter (where ${posts.status} = 'published')::int`,
    })
    .from(series)
    .leftJoin(posts, eq(posts.seriesId, series.id))
    .groupBy(series.id)
    .orderBy(asc(series.title));

  return rows.map((entry) => serializeSeries(entry.row, entry.published));
}

export async function getSeriesById(
  db: BlogDatabase,
  id: string,
): Promise<SeriesRow | null> {
  const [row] = await db.select().from(series).where(eq(series.id, id)).limit(1);
  return row ?? null;
}

export async function getSeriesBySlug(
  db: BlogDatabase,
  slug: string,
): Promise<SeriesRow | null> {
  const [row] = await db.select().from(series).where(eq(series.slug, slug)).limit(1);
  return row ?? null;
}

async function availableSeriesSlug(
  db: BlogDatabase,
  base: string,
  excludeId?: string,
): Promise<string> {
  const collision = or(eq(series.slug, base), like(series.slug, `${base}-%`));
  const rows = await db
    .select({ slug: series.slug })
    .from(series)
    .where(excludeId ? and(collision, ne(series.id, excludeId)) : collision);
  return firstFreeSlug(base, new Set(rows.map((row) => row.slug)));
}

export async function createSeries(
  db: BlogDatabase,
  input: { title: string; description?: string | null; slug?: string },
): Promise<SerializedSeries> {
  const base = input.slug?.trim() || slugify(input.title);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = await availableSeriesSlug(db, base);
    try {
      const [row] = await db
        .insert(series)
        .values({
          title: input.title.trim(),
          slug,
          description: input.description?.trim() || null,
        })
        .returning();
      return serializeSeries(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new ApiError(409, "Could not find a free slug for that series title");
}

export async function updateSeries(
  db: BlogDatabase,
  id: string,
  input: { title?: string; description?: string | null; slug?: string },
): Promise<SerializedSeries> {
  const existing = await getSeriesById(db, id);
  if (!existing) throw notFound("Series");

  const patch: Partial<typeof series.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) {
    patch.description = input.description?.trim() || null;
  }
  if (input.slug !== undefined && input.slug.trim() !== existing.slug) {
    patch.slug = await availableSeriesSlug(db, input.slug.trim(), id);
  }

  if (Object.keys(patch).length === 0) return serializeSeries(existing);

  const [row] = await db
    .update(series)
    .set(patch)
    .where(eq(series.id, id))
    .returning();
  return serializeSeries(row);
}

/** Posts keep existing; their `series_id` is nulled by the FK. */
export async function deleteSeries(db: BlogDatabase, id: string): Promise<void> {
  const deleted = await db
    .delete(series)
    .where(eq(series.id, id))
    .returning({ id: series.id });
  if (deleted.length === 0) throw notFound("Series");
}

export type SeriesContext = {
  series: { title: string; slug: string };
  part: number;
  total: number;
};

/**
 * Which part of its series a post is, counting published posts only and
 * ordering by publication date — so "Part 2" means the second one readers saw,
 * and an unpublished draft in the middle does not shift the numbering.
 */
export async function getSeriesContext(
  db: BlogDatabase,
  post: { id: string; seriesId: string | null },
): Promise<SeriesContext | null> {
  if (!post.seriesId) return null;

  const parent = await getSeriesById(db, post.seriesId);
  if (!parent) return null;

  const ordered = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.seriesId, post.seriesId), eq(posts.status, "published")))
    .orderBy(asc(posts.publishedAt), asc(posts.id));

  const index = ordered.findIndex((row) => row.id === post.id);
  if (index === -1) return null;

  return {
    series: { title: parent.title, slug: parent.slug },
    part: index + 1,
    total: ordered.length,
  };
}

/** Published posts in a series, earliest first — reading order. */
export async function countPublishedInSeries(
  db: BlogDatabase,
  seriesId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(posts)
    .where(and(eq(posts.seriesId, seriesId), eq(posts.status, "published")));
  return row?.value ?? 0;
}
