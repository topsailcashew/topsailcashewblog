import { and, desc, eq, gt, notInArray, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { postRevisions, posts, type PostRevisionRow } from "@/db/schema";

/**
 * How many snapshots to keep per post. Older ones are pruned on write, so the
 * table cannot grow without bound however long a post is worked on.
 */
export const MAX_REVISIONS_PER_POST = 20;

/**
 * The minimum gap between two "edit" snapshots of the same post.
 *
 * This is the rule that keeps the table small. The editor autosaves every ten
 * seconds; snapshotting each one — WordPress's default behaviour — would add
 * ~360 rows an hour for a single writing session. Instead an ordinary edit
 * takes a snapshot at most once an hour, which is enough to recover a
 * paragraph deleted earlier in the day.
 */
const EDIT_THROTTLE = "1 hour";

export type RevisionReason = "edit" | "publish" | "unpublish" | "restore";

export type SerializedRevision = {
  id: string;
  title: string;
  excerpt: string | null;
  reason: RevisionReason;
  created_at: string;
};

function serialize(row: PostRevisionRow): SerializedRevision {
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    reason: row.reason as RevisionReason,
    created_at:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  };
}

/**
 * Snapshots the post *as it currently stands*, before an update overwrites it.
 *
 * Publish transitions always snapshot — those are the moments worth being able
 * to return to. Ordinary edits are throttled, and an edit that would duplicate
 * the newest snapshot is skipped entirely.
 */
export async function snapshotPost(
  db: BlogDatabase,
  postId: string,
  reason: RevisionReason,
): Promise<void> {
  const [current] = await db
    .select({
      title: posts.title,
      excerpt: posts.excerpt,
      contentJson: posts.contentJson,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!current) return;

  const [latest] = await db
    .select({
      id: postRevisions.id,
      title: postRevisions.title,
      excerpt: postRevisions.excerpt,
      contentJson: postRevisions.contentJson,
      createdAt: postRevisions.createdAt,
    })
    .from(postRevisions)
    .where(eq(postRevisions.postId, postId))
    .orderBy(desc(postRevisions.createdAt), desc(postRevisions.id))
    .limit(1);

  if (latest) {
    /*
      Nothing changed since the last snapshot, so a second copy would be a
      duplicate row with a different label on it. The list is a list of
      *versions of the text*; two entries pointing at identical words is
      exactly the bloat this module exists to avoid. Restoring either gives
      the same result, so nothing is lost by keeping one.
    */
    const unchanged =
      latest.title === current.title &&
      (latest.excerpt ?? null) === (current.excerpt ?? null) &&
      JSON.stringify(latest.contentJson ?? null) ===
        JSON.stringify(current.contentJson ?? null);
    if (unchanged) return;

    if (reason === "edit") {
      const [recent] = await db
        .select({ id: postRevisions.id })
        .from(postRevisions)
        .where(
          and(
            eq(postRevisions.postId, postId),
            gt(postRevisions.createdAt, sql`now() - interval '${sql.raw(EDIT_THROTTLE)}'`),
          ),
        )
        .limit(1);
      if (recent) return;
    }
  }

  await db.insert(postRevisions).values({
    postId,
    title: current.title,
    excerpt: current.excerpt,
    contentJson: current.contentJson,
    reason,
  });

  await prune(db, postId);
}

/**
 * Drops everything but the newest MAX_REVISIONS_PER_POST.
 *
 * Deletes by id rather than "older than the oldest kept timestamp": two
 * snapshots can share a `created_at` — `now()` is fixed for a whole
 * transaction — and a timestamp comparison then either spares a row it should
 * drop or drops one it should keep, depending on which side of the boundary
 * the tie lands.
 */
async function prune(db: BlogDatabase, postId: string): Promise<void> {
  const keep = await db
    .select({ id: postRevisions.id })
    .from(postRevisions)
    .where(eq(postRevisions.postId, postId))
    .orderBy(desc(postRevisions.createdAt), desc(postRevisions.id))
    .limit(MAX_REVISIONS_PER_POST);

  if (keep.length < MAX_REVISIONS_PER_POST) return;

  await db.delete(postRevisions).where(
    and(
      eq(postRevisions.postId, postId),
      notInArray(
        postRevisions.id,
        keep.map((row) => row.id),
      ),
    ),
  );
}

export async function listRevisions(
  db: BlogDatabase,
  postId: string,
): Promise<SerializedRevision[]> {
  const rows = await db
    .select()
    .from(postRevisions)
    .where(eq(postRevisions.postId, postId))
    // Same tiebreaker as prune, so the list and the pruning agree on which
    // snapshot is "newest" when two share a timestamp.
    .orderBy(desc(postRevisions.createdAt), desc(postRevisions.id));
  return rows.map(serialize);
}

export async function getRevision(
  db: BlogDatabase,
  revisionId: string,
): Promise<PostRevisionRow | null> {
  const [row] = await db
    .select()
    .from(postRevisions)
    .where(eq(postRevisions.id, revisionId))
    .limit(1);
  return row ?? null;
}
