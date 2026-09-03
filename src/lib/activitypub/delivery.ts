import { and, desc, eq, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { apDeliveries, apFollowers, posts } from "@/db/schema";
import { AP_CONTENT_TYPE, fetchRemoteActor, keyId } from "./actor";
import { buildCreate, type FederatedPost } from "./activities";
import { signRequest } from "./signatures";

/**
 * Followers, and getting activities to them.
 *
 * Delivery in ActivityPub is push: there is no feed anyone pulls. Every
 * follower's server has to be handed the activity, signed, one HTTP request at
 * a time — and a good proportion of those requests fail, because instances go
 * down, defederate, or simply stop existing. That is normal, and the reason
 * every attempt is logged rather than silently swallowed.
 */

/** Bounded by the Worker's subrequest allowance, like the newsletter's batches. */
export const MAX_INBOXES_PER_RUN = 20;

export async function addFollower(
  db: BlogDatabase,
  follower: { actorUri: string; inboxUri: string; sharedInboxUri: string | null; handle: string | null },
): Promise<void> {
  await db
    .insert(apFollowers)
    .values({
      actorUri: follower.actorUri,
      inboxUri: follower.inboxUri,
      sharedInboxUri: follower.sharedInboxUri,
      handle: follower.handle,
      active: true,
    })
    .onConflictDoUpdate({
      target: apFollowers.actorUri,
      // A re-follow refreshes the inbox too: instances move endpoints, and a
      // stale inbox is a follower who silently stops receiving anything.
      set: {
        inboxUri: follower.inboxUri,
        sharedInboxUri: follower.sharedInboxUri,
        handle: follower.handle,
        active: true,
      },
    });
}

export async function removeFollower(db: BlogDatabase, actorUri: string): Promise<void> {
  // Deactivated, not deleted: an unfollow followed by a re-follow is common,
  // and the row carries the inbox we would otherwise have to fetch again.
  await db
    .update(apFollowers)
    .set({ active: false })
    .where(eq(apFollowers.actorUri, actorUri));
}

export async function listFollowerUris(db: BlogDatabase, limit = 500): Promise<string[]> {
  const rows = await db
    .select({ actorUri: apFollowers.actorUri })
    .from(apFollowers)
    .where(eq(apFollowers.active, true))
    .orderBy(desc(apFollowers.createdAt))
    .limit(limit);
  return rows.map((row) => row.actorUri);
}

export async function countFollowers(db: BlogDatabase): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(apFollowers)
    .where(eq(apFollowers.active, true));
  return row?.value ?? 0;
}

/**
 * The distinct inboxes a broadcast has to reach.
 *
 * Grouped by shared inbox where one is offered. A thousand followers on one
 * Mastodon instance are one POST to that instance's shared inbox rather than a
 * thousand — which is the difference between federation being affordable from
 * a Worker and not.
 */
export async function listDeliveryInboxes(db: BlogDatabase): Promise<string[]> {
  const rows = await db
    .select({
      inbox: sql<string>`coalesce(${apFollowers.sharedInboxUri}, ${apFollowers.inboxUri})`,
    })
    .from(apFollowers)
    .where(eq(apFollowers.active, true))
    .groupBy(sql`coalesce(${apFollowers.sharedInboxUri}, ${apFollowers.inboxUri})`);
  return rows.map((row) => row.inbox);
}

export type DeliveryResult = { delivered: number; failed: number; inboxes: number };

/**
 * Signs an activity and posts it to every follower inbox.
 *
 * Failures are recorded and moved past. One instance refusing the message must
 * not stop the other nineteen receiving it, and "nobody saw the post" is
 * indistinguishable from "nobody cared" unless the attempts are written down.
 */
export async function deliverActivity(
  db: BlogDatabase,
  activity: unknown,
  privateKeyPem: string,
  options: { postId?: string; inboxes?: string[] } = {},
): Promise<DeliveryResult> {
  const inboxes = (options.inboxes ?? (await listDeliveryInboxes(db))).slice(
    0,
    MAX_INBOXES_PER_RUN,
  );
  const body = JSON.stringify(activity);
  const result: DeliveryResult = { delivered: 0, failed: 0, inboxes: inboxes.length };

  for (const inbox of inboxes) {
    let statusCode: number | null = null;
    let error: string | null = null;

    try {
      const headers = await signRequest({
        method: "POST",
        url: inbox,
        body,
        privateKeyPem,
        keyId: keyId(),
      });

      const response = await fetch(inbox, {
        method: "POST",
        headers: { ...headers, accept: AP_CONTENT_TYPE },
        body,
        signal: AbortSignal.timeout(8000),
      });

      statusCode = response.status;
      if (response.ok) result.delivered += 1;
      else {
        result.failed += 1;
        error = (await response.text().catch(() => "")).slice(0, 300) || null;
      }
    } catch (cause) {
      result.failed += 1;
      error = cause instanceof Error ? cause.message.slice(0, 300) : "Delivery failed";
    }

    await db.insert(apDeliveries).values({
      postId: options.postId ?? null,
      inboxUri: inbox,
      statusCode,
      error,
    });
  }

  return result;
}

/** Delivers one Accept to the actor that asked to follow. */
export async function deliverTo(
  db: BlogDatabase,
  actorUri: string,
  activity: unknown,
  privateKeyPem: string,
): Promise<boolean> {
  const actor = await fetchRemoteActor(actorUri);
  if (!actor) return false;

  const result = await deliverActivity(db, activity, privateKeyPem, {
    inboxes: [actor.inbox],
  });
  return result.delivered > 0;
}

/**
 * Broadcasts a post, once.
 *
 * `federated_at` is checked and stamped here rather than by the caller. An
 * Update activity is honoured by some instances and ignored by others, so
 * re-announcing an edited post would put a duplicate in some timelines and
 * nothing in the rest — the safe behaviour is to announce each post exactly
 * once, and this is the only place that decides so.
 */
export async function federatePost(
  db: BlogDatabase,
  post: FederatedPost,
  privateKeyPem: string,
): Promise<DeliveryResult & { skipped: boolean }> {
  const claimed = await db
    .update(posts)
    .set({ federatedAt: new Date() })
    .where(and(eq(posts.id, post.id), sql`${posts.federatedAt} is null`))
    .returning({ id: posts.id });

  if (claimed.length === 0) {
    return { delivered: 0, failed: 0, inboxes: 0, skipped: true };
  }

  const result = await deliverActivity(db, buildCreate(post), privateKeyPem, {
    postId: post.id,
  });
  return { ...result, skipped: false };
}
