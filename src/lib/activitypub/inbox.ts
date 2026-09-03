import { eq } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { comments, posts } from "@/db/schema";
import { absoluteUrl } from "../site";
import { buildAccept, noteId } from "./activities";
import { addFollower, deliverTo, removeFollower } from "./delivery";
import { fetchRemoteActor } from "./actor";

/**
 * Everything another server sends us.
 *
 * The signature has already been verified by the route before anything here
 * runs — so `activity.actor` is known to be who they say. That is the only
 * thing that is known: the rest of the document is a stranger's JSON, and
 * every field is treated as such.
 *
 * Four activity types are handled. Everything else is accepted with a 202 and
 * discarded, which is what the specification asks for and what keeps a remote
 * server from retrying forever.
 */

export type InboxOutcome = {
  handled: boolean;
  /** For the log, not for the remote server. */
  note: string;
};

type Activity = {
  type?: string;
  id?: string;
  actor?: string;
  object?: unknown;
};

export async function handleActivity(
  db: BlogDatabase,
  activity: Activity,
  context: { privateKeyPem: string; verifiedKeyId: string },
): Promise<InboxOutcome> {
  const actorUri = typeof activity.actor === "string" ? activity.actor : null;
  if (!actorUri) return { handled: false, note: "No actor" };

  /*
    The signature proves whoever holds the key at `verifiedKeyId` sent this.
    It does not prove they are the actor the body claims to be — without this
    check, anyone with any valid fediverse account could post an activity
    attributed to somebody else and have it accepted.
  */
  if (!sameActor(context.verifiedKeyId, actorUri)) {
    return { handled: false, note: "Signature key does not belong to the actor" };
  }

  switch (activity.type) {
    case "Follow":
      return follow(db, activity, actorUri, context.privateKeyPem);
    case "Undo":
      return undo(db, activity, actorUri);
    case "Create":
      return createNote(db, activity, actorUri);
    case "Delete":
      return remove(db, activity, actorUri);
    default:
      return { handled: false, note: `Ignored ${activity.type ?? "untyped"} activity` };
  }
}

async function follow(
  db: BlogDatabase,
  activity: Activity,
  actorUri: string,
  privateKeyPem: string,
): Promise<InboxOutcome> {
  const actor = await fetchRemoteActor(actorUri);
  if (!actor) return { handled: false, note: "Could not fetch the follower's actor" };

  await addFollower(db, {
    actorUri: actor.id,
    inboxUri: actor.inbox,
    sharedInboxUri: actor.sharedInbox,
    handle: actor.handle,
  });

  /*
    The Accept completes the handshake. Without it the follower's own server
    leaves the follow "pending" indefinitely and, on most implementations,
    never shows them anything we send.
  */
  const accepted = await deliverTo(
    db,
    actorUri,
    buildAccept({ id: activity.id, actor: actorUri }),
    privateKeyPem,
  );

  return {
    handled: true,
    note: accepted ? `${actor.handle ?? actorUri} followed` : "Followed, but Accept failed",
  };
}

async function undo(
  db: BlogDatabase,
  activity: Activity,
  actorUri: string,
): Promise<InboxOutcome> {
  const inner = activity.object as Activity | undefined;
  if (inner?.type !== "Follow") {
    return { handled: false, note: `Ignored Undo of ${inner?.type ?? "unknown"}` };
  }
  await removeFollower(db, actorUri);
  return { handled: true, note: `${actorUri} unfollowed` };
}

/**
 * A federated reply, routed into the same moderation queue as a web comment.
 *
 * That is the whole point of accepting these: a reply on Mastodon and a
 * comment typed into the page are the same thing to a reader, and having two
 * places to moderate means one of them stops being read. It lands as
 * `pending`, exactly like a web comment, and is invisible until approved.
 */
async function createNote(
  db: BlogDatabase,
  activity: Activity,
  actorUri: string,
): Promise<InboxOutcome> {
  const object = activity.object as
    | { id?: string; type?: string; content?: string; inReplyTo?: string; attributedTo?: string }
    | undefined;

  if (!object || object.type !== "Note") {
    return { handled: false, note: `Ignored Create of ${object?.type ?? "unknown"}` };
  }
  if (!object.id || !object.inReplyTo) {
    return { handled: false, note: "Note is not a reply to anything" };
  }

  const postId = postIdFromNoteUri(object.inReplyTo);
  if (!postId) return { handled: false, note: "Reply is not to one of our notes" };

  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!post) return { handled: false, note: "Reply is to a post that no longer exists" };

  const body = stripHtml(object.content ?? "").trim();
  if (body === "") return { handled: false, note: "Empty reply" };

  const actor = await fetchRemoteActor(actorUri);

  await db
    .insert(comments)
    .values({
      postId: post.id,
      authorName: actor?.handle ?? actorUri,
      // No email exists for a federated author; the identity is the actor URI,
      // which the schema's check constraint requires instead.
      authorEmail: null,
      body: body.slice(0, 4000),
      status: "pending",
      source: "fediverse",
      remoteActorUri: actorUri,
      remoteObjectUri: object.id,
    })
    // The same activity is routinely delivered more than once; the unique
    // index on remote_object_uri is what makes that harmless.
    .onConflictDoNothing({ target: comments.remoteObjectUri });

  return { handled: true, note: `Reply from ${actor?.handle ?? actorUri} queued` };
}

/**
 * A remote object was deleted.
 *
 * Honoured for replies only. Someone deleting their post on their own server
 * has withdrawn it, and continuing to hold it in a moderation queue here is
 * both rude and, in several jurisdictions, not ours to decide.
 */
async function remove(
  db: BlogDatabase,
  activity: Activity,
  actorUri: string,
): Promise<InboxOutcome> {
  const objectId =
    typeof activity.object === "string"
      ? activity.object
      : (activity.object as { id?: string } | undefined)?.id;
  if (!objectId) return { handled: false, note: "Delete named no object" };

  // Scoped to the actor's own comments: a Delete is not authority over
  // anyone else's.
  const deleted = await db
    .delete(comments)
    .where(eq(comments.remoteObjectUri, objectId))
    .returning({ id: comments.id, actor: comments.remoteActorUri });

  const mine = deleted.filter((row) => row.actor === actorUri);
  return {
    handled: mine.length > 0,
    note: mine.length > 0 ? "Reply withdrawn" : "Nothing to delete",
  };
}

/**
 * Whether a verified key belongs to the claimed actor.
 *
 * Compared by origin and path, ignoring the `#main-key` fragment: the key id
 * is a pointer inside the actor document, so it is the same URL with a
 * fragment attached.
 */
export function sameActor(keyId: string, actorUri: string): boolean {
  const strip = (value: string) => value.split("#")[0].replace(/\/+$/, "");
  return strip(keyId) === strip(actorUri);
}

/** `https://blog/ap/notes/<uuid>` back to the post id. */
export function postIdFromNoteUri(uri: string): string | null {
  const prefix = absoluteUrl("/ap/notes/");
  if (!uri.startsWith(prefix)) return null;

  const id = uri.slice(prefix.length).split(/[/?#]/)[0];
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export { noteId };

/**
 * Reduces a remote server's HTML to text.
 *
 * Nothing here is ever rendered as markup: the comment is stored as text and
 * escaped on the way out, so this is about legibility rather than safety. `<br>`
 * and `</p>` become newlines because otherwise a multi-paragraph reply arrives
 * as one run-on sentence.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n");
}
