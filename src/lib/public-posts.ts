import { and, asc, count, desc, eq, ne, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { postTags, posts, series, tags } from "@/db/schema";
import { serializePost, type SerializedPost } from "./posts";
import { getTagsForPosts } from "./tags";

/**
 * Every read the public site performs.
 *
 * Kept apart from `posts.ts` (which the admin uses) so the `status =
 * 'published'` predicate lives in one auditable place. Nothing here can return
 * a draft, whatever the caller asks for.
 */

/** Posts per page. 12 fills the 3-column grid evenly (Design.md §5). */
export const POSTS_PER_PAGE = 12;

const publishedOnly = eq(posts.status, "published");

/** Newest first. `published_at` is always set once a post has been published. */
const publishedOrder = [desc(posts.publishedAt), desc(posts.id)];

export type PostSummary = {
  title: string;
  slug: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  publishedAt: string;
  readingMinutes: number;
  tags: { name: string; slug: string }[];
};

export type Feed = {
  posts: PostSummary[];
  page: number;
  totalPages: number;
  totalPosts: number;
};

export async function getFeed(
  db: BlogDatabase,
  page = 1,
  tagSlug?: string,
): Promise<Feed> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const offset = (safePage - 1) * POSTS_PER_PAGE;

  const [rows, total] = await Promise.all([
    tagSlug
      ? db
          .select({ post: posts })
          .from(posts)
          .innerJoin(postTags, eq(postTags.postId, posts.id))
          .innerJoin(tags, eq(tags.id, postTags.tagId))
          .where(and(publishedOnly, eq(tags.slug, tagSlug)))
          .orderBy(...publishedOrder)
          .limit(POSTS_PER_PAGE)
          .offset(offset)
          .then((result) => result.map((entry) => entry.post))
      : db
          .select()
          .from(posts)
          .where(publishedOnly)
          .orderBy(...publishedOrder)
          .limit(POSTS_PER_PAGE)
          .offset(offset),
    countPublished(db, tagSlug),
  ]);

  const tagsByPost = await getTagsForPosts(
    db,
    rows.map((row) => row.id),
  );

  return {
    posts: rows.map((row) =>
      toSummary(serializePost(row, tagsByPost.get(row.id) ?? [])),
    ),
    page: safePage,
    totalPosts: total,
    totalPages: Math.max(1, Math.ceil(total / POSTS_PER_PAGE)),
  };
}

export async function countPublished(
  db: BlogDatabase,
  tagSlug?: string,
): Promise<number> {
  if (!tagSlug) {
    const [row] = await db.select({ value: count() }).from(posts).where(publishedOnly);
    return row?.value ?? 0;
  }

  const [row] = await db
    .select({ value: count() })
    .from(posts)
    .innerJoin(postTags, eq(postTags.postId, posts.id))
    .innerJoin(tags, eq(tags.id, postTags.tagId))
    .where(and(publishedOnly, eq(tags.slug, tagSlug)));
  return row?.value ?? 0;
}

/** The full post, or null when the slug is unknown *or still a draft*. */
export async function getPublishedPost(
  db: BlogDatabase,
  slug: string,
): Promise<SerializedPost | null> {
  const [row] = await db
    .select()
    .from(posts)
    .where(and(publishedOnly, eq(posts.slug, slug)))
    .limit(1);
  if (!row) return null;

  const tagsByPost = await getTagsForPosts(db, [row.id]);
  return serializePost(row, tagsByPost.get(row.id) ?? []);
}

/** How many results a search page shows before it stops. */
export const SEARCH_LIMIT = 25;

export type SearchResult = PostSummary & { rank: number };

/**
 * Full-text search over title, excerpt and body.
 *
 * `websearch_to_tsquery` is used rather than `plainto_tsquery` so a reader can
 * type quoted phrases and `-exclusions` the way they would in a search engine,
 * and so a stray operator character cannot raise a syntax error.
 */
export async function searchPublished(
  db: BlogDatabase,
  query: string,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed === "") return [];

  const tsquery = sql`websearch_to_tsquery('english', ${trimmed})`;
  const rank = sql<number>`ts_rank(${posts.searchVector}, ${tsquery})`;

  const rows = await db
    .select({ post: posts, rank })
    .from(posts)
    .where(and(publishedOnly, sql`${posts.searchVector} @@ ${tsquery}`))
    .orderBy(desc(rank), desc(posts.publishedAt))
    .limit(SEARCH_LIMIT);

  const tagsByPost = await getTagsForPosts(
    db,
    rows.map((row) => row.post.id),
  );

  return rows.map((row) => ({
    ...toSummary(serializePost(row.post, tagsByPost.get(row.post.id) ?? [])),
    rank: Number(row.rank),
  }));
}

/** Published posts in a series, earliest first — the order they were meant to be read. */
export async function getSeriesPosts(
  db: BlogDatabase,
  seriesSlug: string,
): Promise<PostSummary[]> {
  const rows = await db
    .select({ post: posts })
    .from(posts)
    .innerJoin(series, eq(series.id, posts.seriesId))
    .where(and(publishedOnly, eq(series.slug, seriesSlug)))
    .orderBy(asc(posts.publishedAt), asc(posts.id));

  const tagsByPost = await getTagsForPosts(
    db,
    rows.map((row) => row.post.id),
  );
  return rows.map((row) =>
    toSummary(serializePost(row.post, tagsByPost.get(row.post.id) ?? [])),
  );
}

/** Series slugs with at least one published post — for pre-rendering. */
export async function listPublishedSeriesSlugs(
  db: BlogDatabase,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ slug: series.slug })
    .from(series)
    .innerJoin(posts, eq(posts.seriesId, series.id))
    .where(publishedOnly);
  return rows.map((row) => row.slug);
}

/**
 * Sidebar suggestions for a post page.
 *
 * Posts sharing a tag come first — they are the ones most likely to be worth
 * reading next — then recent posts fill any remaining slots, so the sidebar is
 * never short on a site with few tags.
 */
export async function getRelatedPosts(
  db: BlogDatabase,
  post: { id: string; tags: { slug: string }[] },
  limit = 3,
): Promise<PostSummary[]> {
  const tagSlugs = post.tags.map((tag) => tag.slug);
  const picked = new Map<string, (typeof posts.$inferSelect)>();

  if (tagSlugs.length > 0) {
    const sameTag = await db
      .selectDistinct({ post: posts })
      .from(posts)
      .innerJoin(postTags, eq(postTags.postId, posts.id))
      .innerJoin(tags, eq(tags.id, postTags.tagId))
      .where(
        and(
          publishedOnly,
          ne(posts.id, post.id),
          sql`${tags.slug} = any(${sql.param(tagSlugs)}::text[])`,
        ),
      )
      .orderBy(...publishedOrder)
      .limit(limit);
    for (const row of sameTag) picked.set(row.post.id, row.post);
  }

  if (picked.size < limit) {
    const recent = await db
      .select()
      .from(posts)
      .where(and(publishedOnly, ne(posts.id, post.id)))
      .orderBy(...publishedOrder)
      .limit(limit + 1);
    for (const row of recent) {
      if (picked.size >= limit) break;
      if (!picked.has(row.id)) picked.set(row.id, row);
    }
  }

  const rows = [...picked.values()].slice(0, limit);
  const tagsByPost = await getTagsForPosts(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toSummary(serializePost(row, tagsByPost.get(row.id) ?? [])));
}

/** Full published posts, newest first — the RSS feed's source. */
export async function listPublishedForFeed(
  db: BlogDatabase,
  limit = 50,
): Promise<SerializedPost[]> {
  const rows = await db
    .select()
    .from(posts)
    .where(publishedOnly)
    .orderBy(...publishedOrder)
    .limit(limit);

  const tagsByPost = await getTagsForPosts(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => serializePost(row, tagsByPost.get(row.id) ?? []));
}

/** Slugs to pre-render at build time. */
export async function listPublishedSlugs(db: BlogDatabase): Promise<string[]> {
  const rows = await db
    .select({ slug: posts.slug })
    .from(posts)
    .where(publishedOnly)
    .orderBy(...publishedOrder);
  return rows.map((row) => row.slug);
}

/** Tags carrying at least one published post. */
export async function listPublishedTagSlugs(db: BlogDatabase): Promise<string[]> {
  const rows = await db
    .selectDistinct({ slug: tags.slug })
    .from(tags)
    .innerJoin(postTags, eq(postTags.tagId, tags.id))
    .innerJoin(posts, eq(posts.id, postTags.postId))
    .where(publishedOnly);
  return rows.map((row) => row.slug);
}

/** Display name for a tag slug, or null if no published post carries it. */
export async function getTagName(
  db: BlogDatabase,
  slug: string,
): Promise<string | null> {
  const [row] = await db
    .select({ name: tags.name })
    .from(tags)
    .innerJoin(postTags, eq(postTags.tagId, tags.id))
    .innerJoin(posts, eq(posts.id, postTags.postId))
    .where(and(publishedOnly, eq(tags.slug, slug)))
    .limit(1);
  return row?.name ?? null;
}

/** Newest publish timestamp, used as the RSS channel's lastBuildDate. */
export async function getLatestPublishedAt(db: BlogDatabase): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${posts.publishedAt})` })
    .from(posts)
    .where(publishedOnly);
  const value = row?.at ?? null;
  return value ? new Date(value) : null;
}

const WORDS_PER_MINUTE = 200;

/**
 * Words divided by 200, rounded up. Counts the rendered text rather than the
 * markup, so tags and attributes do not inflate it.
 */
export function readingMinutes(html: string | null): number {
  if (!html) return 1;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

export function toSummary(post: SerializedPost): PostSummary {
  return {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    coverImageUrl: post.cover_image_url,
    // A published post always has this set; fall back so the type stays honest.
    publishedAt: post.published_at ?? post.created_at,
    readingMinutes: readingMinutes(post.content_html),
    tags: post.tags.map((tag) => ({ name: tag.name, slug: tag.slug })),
  };
}
