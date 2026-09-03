import { eq } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { settings } from "@/db/schema";
import { base64UrlDecode, base64UrlEncode } from "./session";

/**
 * Runtime configuration, stored in the database rather than in the deployment.
 *
 * The rule for what belongs here: if changing it should not require a
 * redeploy, it is a setting. SMTP hostnames, the newsletter's from-name and
 * the fediverse handle all qualify. `DATABASE_URL` and `SESSION_SECRET` do
 * not — those are needed *before* the database can be read, and they stay
 * Worker secrets.
 *
 * ## On storing an SMTP password here
 *
 * A Worker secret is strictly safer than a database column: it is not in
 * backups, not in a `select *`, and not visible to anything holding a read
 * replica. But "a settings page you can paste credentials into" is the feature,
 * and a settings page cannot write a Worker secret.
 *
 * So the password is encrypted at rest with AES-GCM under a key derived from
 * SESSION_SECRET, and never leaves the server again — the API returns
 * `has_password: true` and nothing else, so the value cannot be read back out
 * through the admin UI it was typed into. What this defends against is a
 * leaked backup or a stray query result. What it does not defend against is
 * someone who already has both the database and SESSION_SECRET; for that,
 * SMTP_PASSWORD as a Worker secret still takes precedence over anything
 * stored here, and remains the recommendation.
 */

const encoder = new TextEncoder();

export async function getSetting<T>(
  db: BlogDatabase,
  key: string,
): Promise<T | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return (row?.value as T | undefined) ?? null;
}

export async function putSetting(
  db: BlogDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

/* --- secret values ------------------------------------------------------ */

/**
 * AES-GCM key derived from SESSION_SECRET.
 *
 * SHA-256 of the secret rather than the raw bytes, so any length of secret
 * yields the 256 bits AES-GCM wants. Rotating SESSION_SECRET makes stored
 * ciphertext undecryptable — which is the correct outcome: rotating the
 * signing secret already invalidates every session, and a stored credential
 * that survived a key rotation would be the surprising thing.
 */
async function secretKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** `v1.<iv>.<ciphertext>`, both base64url. */
export async function encryptSecret(
  plaintext: string,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await secretKey(secret),
    encoder.encode(plaintext),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/** Returns null for anything that does not decrypt — never throws. */
export async function decryptSecret(
  token: string | null | undefined,
  secret: string,
): Promise<string | null> {
  if (!token) return null;
  const [version, ivPart, dataPart] = token.split(".");
  if (version !== "v1" || !ivPart || !dataPart) return null;

  const iv = base64UrlDecode(ivPart);
  const data = base64UrlDecode(dataPart);
  if (!iv || !data) return null;

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      await secretKey(secret),
      data,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Wrong key, tampered ciphertext, or a value written under a rotated
    // secret. All three mean the same thing to the caller: no usable value.
    return null;
  }
}
