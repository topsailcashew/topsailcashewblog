import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { posts, type PostRow, type PostStatus } from "@/db/schema";
import { ApiError, notFound } from "./http";
import { recordSlugChange } from "./redirects";
import { slugify, withUniqueSlug } from "./slug";
import { snapshotPost, type RevisionReason } from "./revisions";
import { getTagsForPosts, syncPostTags, type TagSummary } from "./tags";
import type { CreatePostInput, ListPostsQuery, UpdatePostInput } from "./validation";

export type SerializedPost = {
  id: string;
  title: string;
  slug: string;
  content_json: unknown;
  content_html: string | null;
  excerpt: string | null;
  cover_image_url: string | null;
  status: PostStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  series_id: string | null;
  meta_title: string | null;
  meta_description: string | null;
  canonical_url: string | null;
  noindex: boolean;
  og_image_url: string | null;
  deleted_at: string | null;
  tags: TagSummary[];
};

/** Drafts sort by when they were started, published posts by when they went live. */
const feedOrder = sql`coalesce(${posts.publishedAt}, ${posts.createdAt}) desc, ${posts.id} desc`;

/**
 * The admin list.
 *
 * Trashed posts are excluded unless they are what you asked for. Keeping that
 * here rather than at the call sites means a new admin screen cannot forget
 * it and quietly list deleted work alongside live work.
 */
export async function listPosts(
  db: BlogDatabase,
  query: ListPostsQuery,
): Promise<SerializedPost[]> {
  const inTrash = query.status === "trash";
  // Narrowed deliberately: "trash" is a view, not a value the column can hold.
  const statusFilter = query.status === "trash" ? undefined : query.status;

  const rows = await db
    .select()
    .from(posts)
    .where(
      and(
        inTrash ? isNotNull(posts.deletedAt) : isNull(posts.deletedAt),
        statusFilter ? eq(posts.status, statusFilter) : undefined,
      ),
    )
    .orderBy(inTrash ? sql`${posts.deletedAt} desc` : feedOrder)
    .limit(query.limit)
    .offset(query.offset);

  return attachTags(db, rows);
}

export async function getPostById(
  db: BlogDatabase,
  id: string,
): Promise<SerializedPost | null> {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  if (!row) return null;
  const [post] = await attachTags(db, [row]);
  return post;
}

export async function createPost(
  db: BlogDatabase,
  input: CreatePostInput,
): Promise<SerializedPost> {
  const status = input.status ?? "draft";
  // An explicit slug is honoured as-is; otherwise derive one from the title.
  // Either way the `-2`, `-3`, ... suffix search guarantees uniqueness.
  const base = input.slug ?? slugify(input.title);

  const row = await withUniqueSlug(db, base, async (slug) => {
    const [created] = await db
      .insert(posts)
      .values({
        title: input.title.trim(),
        slug,
        contentJson: input.content_json ?? null,
        contentHtml: input.content_html ?? null,
        excerpt: input.excerpt ?? null,
        coverImageUrl: emptyToNull(input.cover_image_url),
        status,
        seriesId: input.series_id ?? null,
        publishedAt: input.published_at
          ? new Date(input.published_at)
          : status === "published"
            ? new Date()
            : null,
        ...seoValues(input),
      })
      .returning();
    return created;
  });

  const tags = input.tags?.length ? await syncPostTags(db, row.id, input.tags) : [];
  return serializePost(row, tags);
}

/** What the post looked like before an update, for cache invalidation. */
export type PreviousPostState = {
  slug: string;
  status: PostStatus;
  tagSlugs: string[];
  seriesId: string | null;
};

export type UpdatePostResult = {
  post: SerializedPost;
  previous: PreviousPostState;
};

export async function updatePost(
  db: BlogDatabase,
  id: string,
  input: UpdatePostInput,
): Promise<UpdatePostResult> {
  const [existing] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  if (!existing) throw notFound("Post");

  // Captured before anything is written: a rename or a retag has to invalidate
  // the URLs the post used to occupy as well as the ones it moves to.
  const previousTags = (await getTagsForPosts(db, [id])).get(id) ?? [];
  const previous: PreviousPostState = {
    slug: existing.slug,
    status: existing.status,
    tagSlugs: previousTags.map((tag) => tag.slug),
    seriesId: existing.seriesId,
  };

  const patch: Partial<typeof posts.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.content_json !== undefined) patch.contentJson = input.content_json;
  if (input.content_html !== undefined) patch.contentHtml = input.content_html;
  if (input.excerpt !== undefined) patch.excerpt = input.excerpt;
  if (input.cover_image_url !== undefined) {
    patch.coverImageUrl = emptyToNull(input.cover_image_url);
  }
  if (input.series_id !== undefined) patch.seriesId = input.series_id;
  applySeo(patch, input);

  if (input.status !== undefined && input.status !== existing.status) {
    patch.status = input.status;
    // First publish stamps the date; unpublishing keeps it, so re-publishing
    // does not silently move the post to the top of the feed.
    if (input.status === "published" && existing.publishedAt === null) {
      patch.publishedAt = new Date();
    }
  }
  // An explicit date wins, and a future one schedules the post.
  if (input.published_at !== undefined) {
    patch.publishedAt = input.published_at ? new Date(input.published_at) : null;
  }

  /*
    Snapshot the post as it stands *before* the update lands. Publish
    transitions always snapshot; ordinary edits are throttled inside
    snapshotPost so ten-second autosaves do not fill the table.
  */
  const reason: RevisionReason =
    input.status !== undefined && input.status !== existing.status
      ? input.status === "published"
        ? "publish"
        : "unpublish"
      : "edit";
  await snapshotPost(db, id, reason);

  // Titles can be edited freely without breaking a permalink — the slug only
  // changes when it is passed explicitly.
  const row =
    input.slug !== undefined && input.slug !== existing.slug
      ? await withUniqueSlug(
          db,
          input.slug,
          (slug) => applyPatch(db, id, { ...patch, slug }),
          { excludeId: id },
        )
      : Object.keys(patch).length > 0
        ? await applyPatch(db, id, patch)
        : existing;

  // The other half of a rename: the old URL keeps working.
  if (row.slug !== existing.slug) {
    await recordSlugChange(db, `/${existing.slug}`, `/${row.slug}`);
  }

  const tags = input.tags ? await syncPostTags(db, id, input.tags) : previousTags;

  return { post: serializePost(row, tags), previous };
}

/** Post counts by status, for the admin overview. Trash is counted separately. */
export async function countPostsByStatus(
  db: BlogDatabase,
): Promise<{ published: number; draft: number; trash: number }> {
  const rows = await db
    .select({
      status: posts.status,
      trashed: isNotNull(posts.deletedAt),
      value: sql<number>`count(*)::int`,
    })
    .from(posts)
    .groupBy(posts.status, sql`${posts.deletedAt} is not null`);

  const counts = { published: 0, draft: 0, trash: 0 };
  for (const row of rows) {
    if (row.trashed) counts.trash += row.value;
    else counts[row.status] += row.value;
  }
  return counts;
}

/**
 * Move a post to the trash.
 *
 * The row survives — tags, revisions and comments with it — so a mistaken
 * delete is one click from undone. The slug stays reserved while it sits
 * there: letting a new post claim the URL would mean a restore silently comes
 * back at `slug-2`, which is a worse surprise than a name being unavailable.
 */
export async function trashPost(db: BlogDatabase, id: string): Promise<void> {
  const updated = await db
    .update(posts)
    .set({ deletedAt: new Date() })
    .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
    .returning({ id: posts.id });
  if (updated.length === 0) throw notFound("Post");
}

export async function restorePost(
  db: BlogDatabase,
  id: string,
): Promise<SerializedPost> {
  const [row] = await db
    .update(posts)
    .set({ deletedAt: null })
    .where(and(eq(posts.id, id), isNotNull(posts.deletedAt)))
    .returning();
  if (!row) throw notFound("Post");
  const [post] = await attachTags(db, [row]);
  return post;
}

/** Delete for real. Only reachable from the trash view. */
export async function purgePost(db: BlogDatabase, id: string): Promise<void> {
  // post_tags and revisions go with it via ON DELETE CASCADE.
  const deleted = await db
    .delete(posts)
    .where(eq(posts.id, id))
    .returning({ id: posts.id });
  if (deleted.length === 0) throw notFound("Post");
}

/** Empties the trash. Returns how many rows went. */
export async function emptyTrash(db: BlogDatabase): Promise<number> {
  const deleted = await db
    .delete(posts)
    .where(isNotNull(posts.deletedAt))
    .returning({ id: posts.id });
  return deleted.length;
}

/**
 * The SEO overrides, on the way in.
 *
 * Empty strings become null so clearing a field in the editor removes the
 * override rather than storing a blank one that would render as an empty
 * meta tag.
 */
type SeoInput = {
  meta_title?: string | null;
  meta_description?: string | null;
  canonical_url?: string | null;
  noindex?: boolean;
  og_image_url?: string | null;
};

function seoValues(input: SeoInput) {
  return {
    metaTitle: emptyToNull(input.meta_title),
    metaDescription: emptyToNull(input.meta_description),
    canonicalUrl: emptyToNull(input.canonical_url),
    noindex: input.noindex ?? false,
    ogImageUrl: emptyToNull(input.og_image_url),
  };
}

function applySeo(patch: Partial<typeof posts.$inferInsert>, input: SeoInput) {
  if (input.meta_title !== undefined) patch.metaTitle = emptyToNull(input.meta_title);
  if (input.meta_description !== undefined) {
    patch.metaDescription = emptyToNull(input.meta_description);
  }
  if (input.canonical_url !== undefined) {
    patch.canonicalUrl = emptyToNull(input.canonical_url);
  }
  if (input.noindex !== undefined) patch.noindex = input.noindex;
  if (input.og_image_url !== undefined) {
    patch.ogImageUrl = emptyToNull(input.og_image_url);
  }
}

async function applyPatch(
  db: BlogDatabase,
  id: string,
  patch: Partial<typeof posts.$inferInsert>,
): Promise<PostRow> {
  const [updated] = await db
    .update(posts)
    .set(patch)
    .where(eq(posts.id, id))
    .returning();
  if (!updated) throw notFound("Post");
  return updated;
}

async function attachTags(
  db: BlogDatabase,
  rows: PostRow[],
): Promise<SerializedPost[]> {
  if (rows.length === 0) return [];
  const tagsByPost = await getTagsForPosts(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => serializePost(row, tagsByPost.get(row.id) ?? []));
}

export function serializePost(row: PostRow, tags: TagSummary[]): SerializedPost {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    content_json: row.contentJson ?? null,
    content_html: row.contentHtml,
    excerpt: row.excerpt,
    cover_image_url: row.coverImageUrl,
    status: row.status,
    published_at: toIso(row.publishedAt),
    created_at: toIso(row.createdAt) ?? "",
    updated_at: toIso(row.updatedAt) ?? "",
    series_id: row.seriesId,
    meta_title: row.metaTitle,
    meta_description: row.metaDescription,
    canonical_url: row.canonicalUrl,
    noindex: row.noindex,
    og_image_url: row.ogImageUrl,
    deleted_at: toIso(row.deletedAt),
    tags,
  };
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value === "" ? null : value;
}

export { ApiError };
