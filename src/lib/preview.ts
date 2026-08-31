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

/** Default lifetime of a share link: long enough to read, short enough to expire. */
export const PREVIEW_TTL_SECONDS = 60 * 60 * 24 * 7;

const TOKEN_VERSION = 1;

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

type PreviewPayload = { v: number; id: string; exp: number };

export async function createPreviewToken(
  postId: string,
  secret: string,
  ttlSeconds: number = PREVIEW_TTL_SECONDS,
): Promise<string> {
  const payload: PreviewPayload = {
    v: TOKEN_VERSION,
    id: postId,
    exp: Math.floor(Date.now() / 1000) + Math.min(ttlSeconds, SESSION_TTL_SECONDS * 4),
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    // Domain-separated from session tokens so neither can ever be replayed as
    // the other, even though both are signed with the same secret.
    encoder.encode(`preview:${body}`),
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The post id the token authorises, or null for anything unverifiable. */
export async function verifyPreviewToken(
  token: string | undefined,
  secret: string,
): Promise<string | null> {
  if (!token) return null;

  const separator = token.indexOf(".");
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = base64UrlDecode(token.slice(separator + 1));
  if (!signature) return null;

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(`preview:${body}`),
  );
  if (!valid) return null;

  const decoded = base64UrlDecode(body);
  if (!decoded) return null;

  let payload: PreviewPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decoded)) as PreviewPayload;
  } catch {
    return null;
  }

  if (payload.v !== TOKEN_VERSION) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.id !== "string" || payload.id.length === 0) return null;

  return payload.id;
}
