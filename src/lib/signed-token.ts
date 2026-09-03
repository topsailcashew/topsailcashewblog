import { base64UrlDecode, base64UrlEncode } from "./session";

/**
 * `<payload>.<signature>` tokens, signed with the app's one HMAC secret.
 *
 * Three separate things had grown their own copy of this — the session cookie,
 * preview links, and now every newsletter link. They differ only in what goes
 * in the payload and how long it lasts, so that is all this asks for.
 *
 * The `purpose` string is signed alongside the payload, which is what stops a
 * token minted for one thing being replayed as another: an unsubscribe link
 * and a preview link are both bearer tokens over the same secret, and without
 * domain separation the only thing keeping them apart would be the shape of
 * the JSON inside.
 */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

type Envelope<T> = { v: number; p: T; exp?: number };

const VERSION = 1;

export async function signToken<T>(
  purpose: string,
  payload: T,
  secret: string,
  ttlSeconds?: number,
): Promise<string> {
  const envelope: Envelope<T> = {
    v: VERSION,
    p: payload,
    ...(ttlSeconds !== undefined
      ? { exp: Math.floor(Date.now() / 1000) + ttlSeconds }
      : {}),
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(envelope)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${purpose}:${body}`),
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The payload, or null for anything that fails to verify. Never throws. */
export async function verifyToken<T>(
  purpose: string,
  token: string | undefined | null,
  secret: string,
): Promise<T | null> {
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
    encoder.encode(`${purpose}:${body}`),
  );
  if (!valid) return null;

  const decoded = base64UrlDecode(body);
  if (!decoded) return null;

  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(new TextDecoder().decode(decoded)) as Envelope<T>;
  } catch {
    return null;
  }

  if (envelope.v !== VERSION) return null;
  // An absent exp means the token does not expire — correct for an
  // unsubscribe link, which has to keep working for as long as the email it
  // is printed in exists.
  if (envelope.exp !== undefined && envelope.exp * 1000 <= Date.now()) return null;
  if (envelope.p === undefined || envelope.p === null) return null;

  return envelope.p;
}
