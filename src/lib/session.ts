/**
 * Signed session cookies for the single admin user.
 *
 * Built on Web Crypto rather than a session library: the payload is one claim
 * ("you are the admin, until this timestamp"), and Web Crypto is the only
 * primitive available in both the Node runtime the proxy runs on and the
 * Workers runtime everything else runs on.
 */

export const SESSION_COOKIE = "blog_session";

/** How long a login lasts before the password is needed again. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const TOKEN_VERSION = 1;

type SessionPayload = {
  v: number;
  sub: string;
  /** Expiry, seconds since epoch. */
  exp: number;
};

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
    // Backed by a concrete ArrayBuffer so it satisfies BufferSource; a plain
    // `new Uint8Array(n)` widens to ArrayBufferLike and Web Crypto rejects it.
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

/** Compares two byte arrays without leaking where they diverge. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison length does not depend on the secret's length.
 */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(digestA), new Uint8Array(digestB));
}

export async function createSessionToken(
  secret: string,
  options: { subject?: string; ttlSeconds?: number } = {},
): Promise<string> {
  const payload: SessionPayload = {
    v: TOKEN_VERSION,
    sub: options.subject ?? "admin",
    exp: Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? SESSION_TTL_SECONDS),
  };

  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(body),
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export type VerifiedSession = { subject: string; expiresAt: number };

/**
 * Returns the session when the signature checks out and it has not expired,
 * otherwise null. Never throws — a malformed cookie is just an absent session.
 */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
): Promise<VerifiedSession | null> {
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
    encoder.encode(body),
  );
  if (!valid) return null;

  const decoded = base64UrlDecode(body);
  if (!decoded) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decoded)) as SessionPayload;
  } catch {
    return null;
  }

  if (payload.v !== TOKEN_VERSION) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;

  return { subject: payload.sub, expiresAt: payload.exp * 1000 };
}

/**
 * Stable, non-reversible fingerprint of a client address.
 *
 * Rate limiting needs to recognise a repeat submitter; it does not need to
 * know who they are. HMAC-ing with the session secret means the stored value
 * is useless to anyone who reads the table, and rotating the secret discards
 * the history rather than leaving raw addresses behind.
 */
export async function hashClientAddress(
  address: string,
  secret: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`comment-ip:${address}`),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

/** Cookie attributes shared by the login and logout responses. */
export function sessionCookieOptions(request: Request, maxAge: number) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    // Allows http://localhost during development; always secure in production.
    secure: new URL(request.url).protocol === "https:",
    maxAge,
  };
}
