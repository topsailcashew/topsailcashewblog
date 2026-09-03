import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { fetchRemoteActor } from "@/lib/activitypub/actor";
import { handleActivity } from "@/lib/activitypub/inbox";
import { ensureKeyPair, loadFediverseSettings } from "@/lib/activitypub/keys";
import { verifySignedRequest } from "@/lib/activitypub/signatures";
import { getSessionSecret } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The inbox. Everything the rest of the network sends us.
 *
 * Two things make this safe to leave open, which it has to be — there is no
 * other way for a stranger's server to reach us:
 *
 *  1. The HTTP signature is verified before a single field of the body is
 *     read, against a key fetched from the actor's own server. An unsigned or
 *     badly signed request never reaches any handler.
 *  2. Nothing it can do is privileged. A Follow adds a row; a reply lands in
 *     the moderation queue as `pending`, exactly like a comment typed into the
 *     page, and stays invisible until it is approved by hand.
 *
 * Failures answer 202 rather than 4xx wherever the request was well-formed.
 * A remote server that gets an error retries — for days, on some
 * implementations — and there is nothing to retry when the answer is "we do
 * not handle Announce".
 */
export async function POST(request: NextRequest) {
  const db = getDb();

  const settings = await loadFediverseSettings(db).catch(() => null);
  if (!settings?.enabled) return new Response("Not found", { status: 404 });

  const secret = getSessionSecret();
  if (!secret) return new Response("Not configured", { status: 500 });

  // Read once, as text. The digest covers these exact bytes, so re-serialising
  // a parsed copy — even with identical fields — would not match.
  const body = await request.text();

  const verified = await verifySignedRequest(
    { method: "POST", url: request.url, headers: request.headers, body },
    resolvePublicKey,
  );

  if (!verified.ok) {
    // 401 here is correct and useful: the sender can fix a signature, and
    // accepting unverified activities is how an inbox becomes a spam relay.
    return Response.json({ error: verified.reason }, { status: 401 });
  }

  let activity: Record<string, unknown>;
  try {
    activity = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const { privateKeyPem } = await ensureKeyPair(db, secret);

  try {
    const outcome = await handleActivity(db, activity, {
      privateKeyPem,
      verifiedKeyId: verified.keyId,
    });
    if (!outcome.handled) console.info("Inbox:", outcome.note);
    return new Response(null, { status: 202 });
  } catch (error) {
    console.error("Inbox handler failed:", error);
    // A 500 invites a retry, which is the right outcome for a transient
    // database failure and harmless for anything else.
    return Response.json({ error: "Could not process the activity" }, { status: 500 });
  }
}

/**
 * Fetches the signing key from the actor it belongs to.
 *
 * Deliberately not cached. A cache here would have to be invalidated when a
 * remote server rotates its key — which it does without telling anyone — and
 * a stale key rejects everything that actor sends until it expires.
 */
async function resolvePublicKey(keyId: string): Promise<string | null> {
  const actor = await fetchRemoteActor(keyId);
  return actor?.publicKeyPem ?? null;
}
