/**
 * Google service-account auth, built on Web Crypto and `fetch`.
 *
 * No Google SDK. `googleapis` is tens of megabytes and `google-auth-library`
 * is not much better; the Worker has around 180 KiB of headroom against
 * Cloudflare's 3 MB limit, so a dependency was never an option. What the SDK
 * would do here is sign a JWT and POST it, which is about sixty lines.
 *
 * A service account rather than user OAuth, deliberately: there is no consent
 * screen, no redirect URI, no refresh token to store and rotate, and no
 * re-authentication when a token is revoked. The writer shares one Drive
 * folder with the service account's address and that is the whole setup. The
 * cost is that the account can only see what has been shared with it — which
 * for an importer is the behaviour you want anyway.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Read-only. The importer never writes to Drive. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Tokens last an hour; refresh a minute early to avoid an expiry race. */
const TOKEN_TTL_SECONDS = 3600;
const REFRESH_MARGIN_MS = 60_000;

export type ServiceAccount = { clientEmail: string; privateKey: string };

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/**
 * Credentials from the environment, or null when the integration is not set up.
 *
 * Returning null rather than throwing lets the admin show "not configured"
 * instead of an error page — not being connected to Drive is a normal state.
 */
export function serviceAccountFromEnv(
  env: Record<string, string | undefined> = process.env,
): ServiceAccount | null {
  const clientEmail = env.GOOGLE_CLIENT_EMAIL?.trim();
  const privateKey = env.GOOGLE_PRIVATE_KEY?.trim();
  if (!clientEmail || !privateKey) return null;
  return { clientEmail, privateKey: normalizePrivateKey(privateKey) };
}

/**
 * A PEM key survives a round trip through an env var in several shapes.
 *
 * `wrangler secret put` keeps real newlines, but a key pasted from the JSON
 * key file arrives with literal backslash-n, and shells sometimes leave the
 * whole thing wrapped in quotes. All three have to work, because getting this
 * wrong produces an opaque "invalid key" from Web Crypto.
 */
function normalizePrivateKey(value: string): string {
  let key = value.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n").trim();
}

/** PEM (base64 DER between the armour lines) to the bytes importKey wants. */
function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (body === "") {
    throw new GoogleAuthError("GOOGLE_PRIVATE_KEY does not look like a PEM key");
  }

  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new GoogleAuthError("GOOGLE_PRIVATE_KEY is not valid base64");
  }

  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Url(input: Uint8Array | string): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signs the assertion Google exchanges for an access token. */
async function createAssertion(account: ServiceAccount): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(account.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (cause) {
    if (cause instanceof GoogleAuthError) throw cause;
    throw new GoogleAuthError(
      "GOOGLE_PRIVATE_KEY could not be read as a PKCS#8 RSA key — copy the " +
        "`private_key` field from the service account JSON exactly.",
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: DRIVE_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + TOKEN_TTL_SECONDS,
    }),
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

type CachedToken = { token: string; expiresAt: number };

/*
  Cached per isolate. A Worker isolate handles many requests, and an import
  makes one Drive call per file — minting a fresh token for each would triple
  the round trips for no benefit.
*/
const tokenCache = new Map<string, CachedToken>();

export async function getAccessToken(account: ServiceAccount): Promise<string> {
  const cached = tokenCache.get(account.clientEmail);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  const assertion = await createAssertion(account);
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GoogleAuthError(
      `Google refused the service account (${response.status}). ${describeTokenError(detail)}`,
    );
  }

  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) {
    throw new GoogleAuthError("Google returned no access token");
  }

  tokenCache.set(account.clientEmail, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? TOKEN_TTL_SECONDS) * 1000,
  });
  return body.access_token;
}

/** Turns Google's terse OAuth errors into something actionable. */
function describeTokenError(detail: string): string {
  if (detail.includes("invalid_grant")) {
    return "Check the clock on this machine and that the key has not been revoked.";
  }
  if (detail.includes("invalid_client") || detail.includes("unauthorized_client")) {
    return "GOOGLE_CLIENT_EMAIL does not match the key, or the account is disabled.";
  }
  return detail.slice(0, 200);
}

/** Clears the cache. Tests only — isolates are short-lived in production. */
export function resetTokenCache(): void {
  tokenCache.clear();
}
