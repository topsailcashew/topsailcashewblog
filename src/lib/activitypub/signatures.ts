import { importPrivateKey, importPublicKey } from "./keys";

/**
 * HTTP Signatures, as the fediverse actually uses them.
 *
 * The spec everyone implements is `draft-cavage-http-signatures-12`, which
 * expired years ago and was superseded by RFC 9421 — and which Mastodon,
 * Pleroma, Misskey and everything else still speak. Implementing the newer one
 * would be correct and would federate with nothing.
 *
 * The shape: a canonical string is built from a named list of headers, signed
 * with the actor's RSA key, and the signature travels in a `Signature` header
 * alongside the header names used to build it. `(request-target)` is a
 * pseudo-header covering the method and path, so a signature cannot be lifted
 * from one endpoint and replayed against another.
 */

export type SignedRequestInit = {
  method: "GET" | "POST";
  url: string;
  body?: string;
  privateKeyPem: string;
  /** The actor's key id, e.g. https://blog.example/ap/actor#main-key */
  keyId: string;
};

const encoder = new TextEncoder();

export async function signRequest(
  init: SignedRequestInit,
): Promise<Record<string, string>> {
  const url = new URL(init.url);
  const date = new Date().toUTCString();

  const headers: Record<string, string> = {
    host: url.host,
    date,
  };

  /*
    The digest binds the body to the signature. Without it the header list
    covers only metadata, and anyone who intercepts the request can swap the
    payload for another while the signature still verifies.
  */
  if (init.body !== undefined) {
    headers.digest = `SHA-256=${await sha256Base64(init.body)}`;
    headers["content-type"] = "application/activity+json";
  }

  const names = ["(request-target)", ...Object.keys(headers)];
  const signingString = buildSigningString(names, {
    "(request-target)": `${init.method.toLowerCase()} ${url.pathname}${url.search}`,
    ...headers,
  });

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importPrivateKey(init.privateKeyPem),
    encoder.encode(signingString),
  );

  return {
    ...headers,
    signature: [
      `keyId="${init.keyId}"`,
      'algorithm="rsa-sha256"',
      `headers="${names.join(" ")}"`,
      `signature="${base64(new Uint8Array(signature))}"`,
    ].join(","),
  };
}

export type SignatureParts = {
  keyId: string;
  algorithm?: string;
  headers: string[];
  signature: string;
};

/**
 * Parses a `Signature` header.
 *
 * Values are comma-separated `name="value"` pairs — but a value may itself
 * contain a comma (base64 does not, but `headers="a b c"` sits beside a keyId
 * that is a URL), so this matches quoted values rather than splitting on
 * commas.
 */
export function parseSignatureHeader(header: string | null): SignatureParts | null {
  if (!header) return null;

  const fields: Record<string, string> = {};
  for (const match of header.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) {
    fields[match[1].toLowerCase()] = match[2];
  }

  if (!fields.keyid || !fields.signature) return null;
  return {
    keyId: fields.keyid,
    algorithm: fields.algorithm,
    // The default when omitted is "date" alone, per the draft.
    headers: (fields.headers ?? "date").split(/\s+/).filter(Boolean),
    signature: fields.signature,
  };
}

export type VerifyResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: string };

/**
 * Verifies an inbound signed request.
 *
 * `resolvePublicKey` is injected rather than called directly here so the tests
 * can verify the protocol without reaching the network, and so the caller
 * decides how remote actors are fetched and cached.
 */
export async function verifySignedRequest(
  request: {
    method: string;
    url: string;
    headers: Headers;
    /** The raw body, exactly as received — a re-serialised copy will not match. */
    body: string;
  },
  resolvePublicKey: (keyId: string) => Promise<string | null>,
  options: { maxSkewSeconds?: number } = {},
): Promise<VerifyResult> {
  const parts = parseSignatureHeader(request.headers.get("signature"));
  if (!parts) return { ok: false, reason: "No signature header" };

  if (parts.algorithm && !/rsa-sha256|hs2019/i.test(parts.algorithm)) {
    return { ok: false, reason: `Unsupported algorithm ${parts.algorithm}` };
  }

  /*
    A signature over headers that do not include the date can be replayed
    forever, and one that omits the digest on a POST does not cover the body
    at all. Both are the difference between "signed" and "meaningful".
  */
  if (!parts.headers.includes("date")) {
    return { ok: false, reason: "Signature does not cover the date" };
  }
  if (request.method.toUpperCase() === "POST" && !parts.headers.includes("digest")) {
    return { ok: false, reason: "Signature does not cover the body digest" };
  }

  const dateHeader = request.headers.get("date");
  const skew = Math.abs(Date.now() - new Date(dateHeader ?? "").getTime());
  const maxSkew = (options.maxSkewSeconds ?? 300) * 1000;
  if (!Number.isFinite(skew) || skew > maxSkew) {
    return { ok: false, reason: "Date is outside the accepted window" };
  }

  const digest = request.headers.get("digest");
  if (parts.headers.includes("digest")) {
    const expected = `SHA-256=${await sha256Base64(request.body)}`;
    // Case-insensitive on the algorithm name only; the base64 must match
    // exactly, and comparing loosely here would defeat the point of it.
    if (!digest || digest.replace(/^sha-256=/i, "SHA-256=") !== expected) {
      return { ok: false, reason: "Body does not match the digest" };
    }
  }

  const url = new URL(request.url);
  const values: Record<string, string> = {
    "(request-target)": `${request.method.toLowerCase()} ${url.pathname}${url.search}`,
  };
  for (const name of parts.headers) {
    if (name === "(request-target)") continue;
    const value = request.headers.get(name);
    if (value === null) {
      return { ok: false, reason: `Signed header ${name} is missing` };
    }
    values[name] = value;
  }

  const publicKeyPem = await resolvePublicKey(parts.keyId);
  if (!publicKeyPem) return { ok: false, reason: "Could not fetch the signing key" };

  let key: CryptoKey;
  try {
    key = await importPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "Signing key is not a usable RSA public key" };
  }

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64(parts.signature),
    encoder.encode(buildSigningString(parts.headers, values)),
  );

  return valid ? { ok: true, keyId: parts.keyId } : { ok: false, reason: "Bad signature" };
}

/** `name: value` per line, lowercase names, no trailing newline. */
export function buildSigningString(
  names: string[],
  values: Record<string, string>,
): string {
  return names
    .map((name) => `${name.toLowerCase()}: ${values[name.toLowerCase()] ?? values[name] ?? ""}`)
    .join("\n");
}

async function sha256Base64(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  return base64(new Uint8Array(digest));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
