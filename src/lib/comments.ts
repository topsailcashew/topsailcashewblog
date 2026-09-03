import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import {
  COMMENT_STATUSES,
  comments,
  posts,
  type CommentRow,
  type CommentSource,
  type CommentStatus,
} from "@/db/schema";
import { ApiError, notFound } from "./http";
import { siteConfig } from "./site";

export { COMMENT_STATUSES, type CommentStatus };

/** Submissions allowed from one address per hour. Override with COMMENT_RATE_LIMIT. */
export function rateLimitPerHour(): number {
  const raw = Number(process.env.COMMENT_RATE_LIMIT ?? "5");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

export const MAX_COMMENT_LENGTH = 4000;

/**
 * What a reader sees. Deliberately has no email field — the address is
 * collected for moderation contact and must never reach a public page, so it
 * is dropped here rather than filtered at each call site.
 */
export type PublicComment = {
  id: string;
  author_name: string;
  body: string;
  created_at: string;
  is_author: boolean;
  replies: PublicComment[];
};

/** What the moderation queue sees, including the email and the post context. */
export type ModerationComment = {
  id: string;
  post: { id: string; title: string; slug: string } | null;
  parent_id: string | null;
  author_name: string;
  /** Null for a federated reply, which arrives with an actor URI instead. */
  author_email: string | null;
  body: string;
  status: CommentStatus;
  is_author: boolean;
  source: CommentSource;
  remote_actor_uri: string | null;
  created_at: string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPublic(row: CommentRow): PublicComment {
  return {
    id: row.id,
    author_name: row.authorName,
    body: row.body,
    created_at: iso(row.createdAt),
    is_author: row.isAuthor,
    replies: [],
  };
}

/**
 * Approved comments for a post, threaded one level deep.
 *
 * Only `approved` rows are read, so a pending or rejected comment cannot
 * surface even as an empty slot in the thread.
 */
export async function getApprovedThread(
  db: BlogDatabase,
  postId: string,
): Promise<PublicComment[]> {
  const rows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.postId, postId), eq(comments.status, "approved")))
    .orderBy(asc(comments.createdAt));

  const topLevel: PublicComment[] = [];
  const byId = new Map<string, PublicComment>();

  for (const row of rows) {
    const node = toPublic(row);
    byId.set(row.id, node);
    if (row.parentId === null) topLevel.push(node);
  }

  for (const row of rows) {
    if (row.parentId === null) continue;
    const parent = byId.get(row.parentId);
    const node = byId.get(row.id);
    if (!node) continue;
    // A reply whose parent is not approved would otherwise vanish; promoting it
    // keeps the conversation readable without exposing the hidden parent.
    if (parent) parent.replies.push(node);
    else topLevel.push(node);
  }

  return topLevel;
}

export async function countApproved(
  db: BlogDatabase,
  postId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(comments)
    .where(and(eq(comments.postId, postId), eq(comments.status, "approved")));
  return row?.value ?? 0;
}

/** How many submissions this address has made in the last hour. */
export async function countRecentFrom(
  db: BlogDatabase,
  ipHash: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(comments)
    .where(
      and(
        eq(comments.authorIpHash, ipHash),
        gt(comments.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  return row?.value ?? 0;
}

export type SubmitCommentInput = {
  postId: string;
  parentId?: string | null;
  authorName: string;
  authorEmail: string;
  body: string;
  ipHash: string | null;
};

/**
 * Records a reader's comment as `pending`. Never returns it for display —
 * the caller only needs to know it was accepted.
 */
export async function submitComment(
  db: BlogDatabase,
  input: SubmitCommentInput,
): Promise<{ id: string }> {
  // Replies only nest one level: a reply aimed at a reply is re-parented to
  // the top-level comment so the thread cannot grow arbitrarily deep.
  let parentId: string | null = null;
  if (input.parentId) {
    const [parent] = await db
      .select({ id: comments.id, parentId: comments.parentId, postId: comments.postId, status: comments.status })
      .from(comments)
      .where(eq(comments.id, input.parentId))
      .limit(1);

    if (!parent || parent.postId !== input.postId || parent.status !== "approved") {
      throw new ApiError(422, "That comment is no longer available to reply to");
    }
    parentId = parent.parentId ?? parent.id;
  }

  const [row] = await db
    .insert(comments)
    .values({
      postId: input.postId,
      parentId,
      authorName: input.authorName.trim(),
      authorEmail: input.authorEmail.trim().toLowerCase(),
      body: input.body.trim(),
      status: "pending",
      authorIpHash: input.ipHash,
    })
    .returning({ id: comments.id });

  return { id: row.id };
}

/** A reply written from the moderation queue: approved on the spot and badged. */
export async function replyAsAuthor(
  db: BlogDatabase,
  input: { parentId: string; authorName: string; authorEmail?: string; body: string },
): Promise<ModerationComment> {
  const [parent] = await db
    .select()
    .from(comments)
    .where(eq(comments.id, input.parentId))
    .limit(1);
  if (!parent) throw notFound("Comment");

  const [row] = await db
    .insert(comments)
    .values({
      postId: parent.postId,
      parentId: parent.parentId ?? parent.id,
      authorName: input.authorName,
      authorEmail: input.authorEmail ?? siteConfig.contactEmail,
      body: input.body.trim(),
      status: "approved",
      isAuthor: true,
    })
    .returning();

  return (await withPostContext(db, [row]))[0];
}

export async function setCommentStatus(
  db: BlogDatabase,
  id: string,
  status: CommentStatus,
): Promise<ModerationComment> {
  const [row] = await db
    .update(comments)
    .set({ status })
    .where(eq(comments.id, id))
    .returning();
  if (!row) throw notFound("Comment");
  return (await withPostContext(db, [row]))[0];
}

export async function listForModeration(
  db: BlogDatabase,
  status?: CommentStatus,
  limit = 200,
  offset = 0,
): Promise<ModerationComment[]> {
  const rows = await db
    .select()
    .from(comments)
    .where(status ? eq(comments.status, status) : undefined)
    .orderBy(desc(comments.createdAt))
    .limit(limit)
    .offset(offset);
  return withPostContext(db, rows);
}

export async function countByStatus(
  db: BlogDatabase,
): Promise<Record<CommentStatus, number>> {
  const rows = await db
    .select({ status: comments.status, value: sql<number>`count(*)::int` })
    .from(comments)
    .groupBy(comments.status);

  const counts = { pending: 0, approved: 0, rejected: 0, spam: 0 };
  for (const row of rows) counts[row.status] = row.value;
  return counts;
}

/** Joins each comment to its post so the queue can show what it is replying to. */
async function withPostContext(
  db: BlogDatabase,
  rows: CommentRow[],
): Promise<ModerationComment[]> {
  if (rows.length === 0) return [];

  const postIds = [...new Set(rows.map((row) => row.postId))];
  const postRows = await db
    .select({ id: posts.id, title: posts.title, slug: posts.slug })
    .from(posts)
    .where(sql`${posts.id} = any(${sql.param(postIds)}::uuid[])`);
  const byId = new Map(postRows.map((row) => [row.id, row]));

  return rows.map((row) => ({
    id: row.id,
    post: byId.get(row.postId) ?? null,
    parent_id: row.parentId,
    author_name: row.authorName,
    author_email: row.authorEmail,
    body: row.body,
    status: row.status,
    is_author: row.isAuthor,
    source: row.source,
    remote_actor_uri: row.remoteActorUri,
    created_at: iso(row.createdAt),
  }));
}

/** Posts that have at least one pending comment — used for the admin badge. */
export async function countPending(db: BlogDatabase): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(comments)
    .where(eq(comments.status, "pending"));
  return row?.value ?? 0;
}
