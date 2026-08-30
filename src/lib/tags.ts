import { sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import type { TagRow } from "@/db/schema";
import { slugify } from "./slug";

export type TagSummary = { id: string; name: string; slug: string };

/**
 * Tags are identified by slug, so "Web Design", "web design" and "web-design"
 * all resolve to the same tag. The first spelling to arrive wins the display
 * name; later posts attach to the existing tag rather than renaming it.
 */
export function normalizeTagNames(
  names: readonly string[],
): { name: string; slug: string }[] {
  const bySlug = new Map<string, { name: string; slug: string }>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const slug = slugify(name);
    if (!bySlug.has(slug)) bySlug.set(slug, { name, slug });
  }
  return [...bySlug.values()];
}

/** Creates any tags that don't exist yet, then returns the full set by slug. */
export async function upsertTags(
  db: BlogDatabase,
  names: readonly string[],
): Promise<TagSummary[]> {
  const normalized = normalizeTagNames(names);
  if (normalized.length === 0) return [];

  const tagNames = normalized.map((tag) => tag.name);
  const tagSlugs = normalized.map((tag) => tag.slug);

  // One statement, so concurrent writers can't half-create the set.
  await db.execute(sql`
    insert into tags (name, slug)
    select * from unnest(${sql.param(tagNames)}::text[], ${sql.param(tagSlugs)}::text[])
    on conflict (slug) do nothing
  `);

  const result = await db.execute<Pick<TagRow, "id" | "name" | "slug">>(sql`
    select id, name, slug from tags where slug = any(${sql.param(tagSlugs)}::text[])
  `);

  const rows = toRows<TagSummary>(result);
  // Return in the order the caller asked for, not the order Postgres scanned.
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  return tagSlugs
    .map((slug) => bySlug.get(slug))
    .filter((tag): tag is TagSummary => tag !== undefined);
}

/**
 * Makes the post's tag set exactly `tagIds`.
 *
 * Written as a single statement on purpose: the Neon HTTP driver has no
 * interactive transactions, and one statement is atomic in Postgres. It is
 * also differential — untouched rows are left alone rather than deleted and
 * rewritten.
 */
export async function setPostTags(
  db: BlogDatabase,
  postId: string,
  tagIds: readonly string[],
): Promise<void> {
  if (tagIds.length === 0) {
    await db.execute(sql`delete from post_tags where post_id = ${postId}`);
    return;
  }

  await db.execute(sql`
    with desired as (
      select unnest(${sql.param([...tagIds])}::uuid[]) as tag_id
    ), removed as (
      delete from post_tags
      where post_id = ${postId}
        and tag_id not in (select tag_id from desired)
    )
    insert into post_tags (post_id, tag_id)
    select ${postId}::uuid, tag_id from desired
    on conflict (post_id, tag_id) do nothing
  `);
}

/** Replaces a post's tags, creating any that are new. */
export async function syncPostTags(
  db: BlogDatabase,
  postId: string,
  names: readonly string[],
): Promise<TagSummary[]> {
  const tags = await upsertTags(db, names);
  await setPostTags(
    db,
    postId,
    tags.map((tag) => tag.id),
  );
  return tags;
}

/** Loads tags for a batch of posts, keyed by post id. */
export async function getTagsForPosts(
  db: BlogDatabase,
  postIds: readonly string[],
): Promise<Map<string, TagSummary[]>> {
  const grouped = new Map<string, TagSummary[]>();
  if (postIds.length === 0) return grouped;

  const result = await db.execute<TagSummary & { post_id: string }>(sql`
    select pt.post_id, t.id, t.name, t.slug
    from post_tags pt
    join tags t on t.id = pt.tag_id
    where pt.post_id = any(${sql.param([...postIds])}::uuid[])
    order by t.name asc
  `);

  for (const row of toRows<TagSummary & { post_id: string }>(result)) {
    const list = grouped.get(row.post_id) ?? [];
    list.push({ id: row.id, name: row.name, slug: row.slug });
    grouped.set(row.post_id, list);
  }
  return grouped;
}

/**
 * `db.execute` returns `{ rows }` on node-postgres but a bare array on the
 * Neon HTTP driver. Normalize so the query layer reads the same on both.
 */
export function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
