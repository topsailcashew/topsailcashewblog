/**
 * Signed, expiring links that let a specific draft be read without a session.
 *
 * The token *is* the capability — anyone holding it can read that one post
 * until it expires — so it is scoped as tightly as that allows: one post id,
 * a short lifetime, and a signature over both. It grants no access to the
 * admin, to other posts, or to any write.
 *
 * Built on the same HMAC helpers as the session cookie rather than a second
 * mechanism, so there is one signing secret to rotate. Rotating SESSION_SECRET
 * invalidates every outstanding preview link, which is the desired behaviour.
 */
import { SESSION_TTL_SECONDS } from "./session";
import { signToken, verifyToken } from "./signed-token";

/** Default lifetime of a share link: long enough to read, short enough to expire. */
export const PREVIEW_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function createPreviewToken(
  postId: string,
  secret: string,
  ttlSeconds: number = PREVIEW_TTL_SECONDS,
): Promise<string> {
  return signToken(
    // Domain-separated from session and newsletter tokens so none can ever be
    // replayed as another, even though all are signed with the same secret.
    "preview",
    { id: postId },
    secret,
    Math.min(ttlSeconds, SESSION_TTL_SECONDS * 4),
  );
}

/** The post id the token authorises, or null for anything unverifiable. */
export async function verifyPreviewToken(
  token: string | undefined,
  secret: string,
): Promise<string | null> {
  const payload = await verifyToken<{ id: string }>("preview", token, secret);
  return typeof payload?.id === "string" && payload.id.length > 0 ? payload.id : null;
}
