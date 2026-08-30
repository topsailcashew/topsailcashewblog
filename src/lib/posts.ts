import { eq, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { posts, type PostRow, type PostStatus } from "@/db/schema";
import { ApiError, notFound } from "./http";
import { slugify, withUniqueSlug } from "./slug";
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
  tags: TagSummary[];
};

/** Drafts sort by when they were started, published posts by when they went live. */
const feedOrder = sql`coalesce(${posts.publishedAt}, ${posts.createdAt}) desc, ${posts.id} desc`;

export async function listPosts(
  db: BlogDatabase,
  query: ListPostsQuery,
): Promise<SerializedPost[]> {
  const rows = await db
    .select()
    .from(posts)
    .where(query.status ? eq(posts.status, query.status) : undefined)
    .orderBy(feedOrder)
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
        publishedAt: status === "published" ? new Date() : null,
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
  };

  const patch: Partial<typeof posts.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.content_json !== undefined) patch.contentJson = input.content_json;
  if (input.content_html !== undefined) patch.contentHtml = input.content_html;
  if (input.excerpt !== undefined) patch.excerpt = input.excerpt;
  if (input.cover_image_url !== undefined) {
    patch.coverImageUrl = emptyToNull(input.cover_image_url);
  }

  if (input.status !== undefined && input.status !== existing.status) {
    patch.status = input.status;
    // First publish stamps the date; unpublishing keeps it, so re-publishing
    // does not silently move the post to the top of the feed.
    if (input.status === "published" && existing.publishedAt === null) {
      patch.publishedAt = new Date();
    }
  }

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

  const tags = input.tags ? await syncPostTags(db, id, input.tags) : previousTags;

  return { post: serializePost(row, tags), previous };
}

export async function deletePost(db: BlogDatabase, id: string): Promise<void> {
  // post_tags rows go with it via ON DELETE CASCADE.
  const deleted = await db
    .delete(posts)
    .where(eq(posts.id, id))
    .returning({ id: posts.id });
  if (deleted.length === 0) throw notFound("Post");
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
