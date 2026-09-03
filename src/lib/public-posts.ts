import { and, asc, count, desc, eq, isNull, ne, sql } from "drizzle-orm";
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

/*
  Published, due, and not in the trash.

  A post whose published_at is in the future is scheduled: it exists, the admin
  can see it, and it appears here the moment the time passes — see the note on
  revalidation in the README. A trashed post is gone as far as every reader is
  concerned, but the row survives until the trash is emptied.

  This is the only place those three conditions are written. Every public query
  in this file composes it, so none of them can forget one.
*/
const publishedOnly = and(
  eq(posts.status, "published"),
  sql`${posts.publishedAt} <= now()`,
  isNull(posts.deletedAt),
);

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

  // Nothing matched the words as spelled. Try again on how they are spelled.
  if (rows.length === 0) return searchByTrigram(db, trimmed);

  const tagsByPost = await getTagsForPosts(
    db,
    rows.map((row) => row.post.id),
  );

  return rows.map((row) => ({
    ...toSummary(serializePost(row.post, tagsByPost.get(row.post.id) ?? [])),
    rank: Number(row.rank),
  }));
}

/**
 * How close a match has to be before it is offered.
 *
 * Measured against this archive rather than guessed. Real typos score
 * 0.33–0.75 ("pivto" 0.33, "urgncy" 0.50, "everythin" 0.75); strings that
 * merely share letters score below 0.31 ("thing" 0.308, "nothing" 0.273,
 * "zzzznothing" 0.222). 0.32 sits in that gap.
 *
 * The line matters because a confident wrong answer is worse than the empty
 * state, which now offers three pieces to read instead of an apology.
 */
const TRIGRAM_THRESHOLD = 0.32;

/**
 * The typo-tolerant fallback.
 *
 * Full-text search matches lexemes: "slow software" finds the post and "slwo
 * software" finds nothing, because the misspelling stems to a word in no
 * document. Trigram similarity compares three-character windows instead, so a
 * transposition still scores highly.
 *
 * Runs only when full-text found nothing, because when the spelling is right
 * `ts_rank` is the better ranking by some distance.
 *
 * Degrades to an empty result if `pg_trgm` is not installed, so search keeps
 * working on a database where migration 0010 has not been applied.
 */
async function searchByTrigram(
  db: BlogDatabase,
  query: string,
): Promise<SearchResult[]> {
  try {
    /*
      `strict_word_similarity`, not `word_similarity`.

      The lenient form scores the query against any contiguous extent of the
      text, so "zzzznothing" matches "Every*thing*" and — worse — the nonsense
      word "thing" scored 0.667 against this archive, above genuine typos like
      "urgncy" at 0.500. No threshold separates those. The strict form only
      considers extents that begin and end on word boundaries, which is what
      "did they mean this word" actually asks.

      This scans rather than using the trigram indexes: those serve the `%`
      operator family, and the operators take their cutoff from a session GUC
      that the HTTP driver gives no good place to set. An explicit comparison
      over one blog's worth of rows costs less than the round trip would, and
      it only runs when full-text already came back empty.
    */
    const similarity = sql<number>`greatest(
      strict_word_similarity(${query}, ${posts.title}),
      strict_word_similarity(${query}, coalesce(${posts.excerpt}, ''))
    )`;

    const rows = await db
      .select({ post: posts, rank: similarity })
      .from(posts)
      .where(and(publishedOnly, sql`${similarity} >= ${TRIGRAM_THRESHOLD}`))
      .orderBy(desc(similarity), desc(posts.publishedAt))
      .limit(SEARCH_LIMIT);

    const tagsByPost = await getTagsForPosts(
      db,
      rows.map((row) => row.post.id),
    );

    return rows.map((row) => ({
      ...toSummary(serializePost(row.post, tagsByPost.get(row.post.id) ?? [])),
      rank: Number(row.rank),
    }));
  } catch {
    // pg_trgm missing, or the query was something it could not handle. An
    // empty result is the honest answer and the page has a good empty state.
    return [];
  }
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
/**
 * Posts eligible for the sitemap.
 *
 * `noindex` posts are excluded: listing a URL in the sitemap while telling the
 * crawler not to index it is a contradiction, and Search Console reports it as
 * an error rather than quietly obeying the meta tag.
 */
/**
 * The post that leads the home page.
 *
 * The newest one marked featured, or — when nothing is marked — the newest
 * post there is. That fallback matters: the home page should never have a
 * hole in it because a box has not been ticked, and on a blog where nothing
 * is ever featured the newest post is the right thing to lead with anyway.
 */
export async function getFeaturedPost(db: BlogDatabase): Promise<PostSummary | null> {
  const pick = async (onlyFeatured: boolean) => {
    const [row] = await db
      .select()
      .from(posts)
      .where(onlyFeatured ? and(publishedOnly, eq(posts.featured, true)) : publishedOnly)
      .orderBy(...publishedOrder)
      .limit(1);
    return row ?? null;
  };

  const row = (await pick(true)) ?? (await pick(false));
  if (!row) return null;

  const tags = (await getTagsForPosts(db, [row.id])).get(row.id) ?? [];
  return toSummary(serializePost(row, tags));
}

/**
 * The tags carrying the most published writing.
 *
 * For the About page's "writes about" line, which should reflect what has
 * actually been written rather than a list someone has to maintain by hand.
 */
export async function listProminentTags(
  db: BlogDatabase,
  limit = 6,
): Promise<{ name: string; slug: string; count: number }[]> {
  const rows = await db
    .select({
      name: tags.name,
      slug: tags.slug,
      count: sql<number>`count(*)::int`,
    })
    .from(tags)
    .innerJoin(postTags, eq(postTags.tagId, tags.id))
    .innerJoin(posts, eq(posts.id, postTags.postId))
    .where(publishedOnly)
    .groupBy(tags.id, tags.name, tags.slug)
    .orderBy(sql`count(*) desc`, asc(tags.name))
    .limit(limit);
  return rows;
}

export async function listIndexableForSitemap(
  db: BlogDatabase,
): Promise<SerializedPost[]> {
  const rows = await db
    .select()
    .from(posts)
    .where(and(publishedOnly, eq(posts.noindex, false)))
    .orderBy(...publishedOrder);
  return rows.map((row) => serializePost(row, []));
}

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

/** How much of the opening to borrow when a post has no excerpt of its own. */
const DERIVED_EXCERPT_CHARS = 180;

/**
 * The excerpt, or the opening of the piece when there is none.
 *
 * A card whose post has no excerpt is a title floating in an empty cell — the
 * grid gives every card in a row the same height, so the space below the title
 * stays blank and the column reads as broken rather than as sparse. Borrowing
 * the first sentences shows what a reader would have got by clicking anyway.
 *
 * Cut at a word boundary and marked with an ellipsis, so it reads as an
 * opening rather than as a sentence that lost its ending.
 */
export function excerptFor(post: {
  excerpt: string | null;
  content_html: string | null;
}): string | null {
  const own = post.excerpt?.trim();
  if (own) return own;

  const text = (post.content_html ?? "")
    // Block boundaries become spaces, or the last word of one paragraph runs
    // into the first word of the next.
    .replace(/<\/(p|h[1-6]|li|blockquote|pre|div)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (text === "") return null;
  if (text.length <= DERIVED_EXCERPT_CHARS) return text;

  const cut = text.slice(0, DERIVED_EXCERPT_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.replace(/[,;:.\s]+$/, "")}…`;
}

export function toSummary(post: SerializedPost): PostSummary {
  return {
    title: post.title,
    slug: post.slug,
    excerpt: excerptFor(post),
    coverImageUrl: post.cover_image_url,
    // A published post always has this set; fall back so the type stays honest.
    publishedAt: post.published_at ?? post.created_at,
    readingMinutes: readingMinutes(post.content_html),
    tags: post.tags.map((tag) => ({ name: tag.name, slug: tag.slug })),
  };
}
