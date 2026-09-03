import type { BlogDatabase } from "@/db/client";
import { decryptSecret, encryptSecret, getSetting, putSetting } from "../settings";
import { siteConfig } from "../site";

/**
 * The blog's federated identity, and the key that proves it.
 *
 * ActivityPub has no accounts and no tokens: an actor *is* an RSA key pair and
 * a URL. Every request this blog sends to another server is signed with the
 * private key, and every server that cares fetches the public half from the
 * actor document to check it. Lose the key and the identity is gone — remote
 * servers will reject everything signed with a new one until their cache
 * expires, which for some instances is never.
 *
 * So it is generated once, stored once, and encrypted at rest under
 * SESSION_SECRET like any other credential (see src/lib/settings.ts). Rotating
 * SESSION_SECRET therefore also discards the fediverse identity, which is
 * worth knowing before rotating it.
 */

export const FEDIVERSE_SETTINGS_KEY = "fediverse";

export type FediverseSettings = {
  /** Off means the endpoints 404 and nothing is ever delivered. */
  enabled: boolean;
  /** The local part of the handle: @username@yourdomain. */
  username: string;
  /** Shown on the profile in a remote client. */
  summary: string;
  /** Ciphertext, PKCS#8. Never leaves the server. */
  privateKeyCipher: string | null;
  /** SPKI PEM. Published in the actor document — it is meant to be public. */
  publicKeyPem: string | null;
};

export const DEFAULT_FEDIVERSE: FediverseSettings = {
  enabled: false,
  username: siteConfig.name,
  summary: siteConfig.description,
  privateKeyCipher: null,
  publicKeyPem: null,
};

const KEY_PARAMS = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
  hash: "SHA-256",
} as const;

export async function loadFediverseSettings(
  db: BlogDatabase,
): Promise<FediverseSettings> {
  const stored = await getSetting<Partial<FediverseSettings>>(db, FEDIVERSE_SETTINGS_KEY);
  return { ...DEFAULT_FEDIVERSE, ...(stored ?? {}) };
}

export async function saveFediverseSettings(
  db: BlogDatabase,
  patch: Partial<Omit<FediverseSettings, "privateKeyCipher" | "publicKeyPem">>,
): Promise<FediverseSettings> {
  const next = { ...(await loadFediverseSettings(db)), ...patch };
  await putSetting(db, FEDIVERSE_SETTINGS_KEY, next);
  return next;
}

/**
 * Returns the key pair, generating it on first use.
 *
 * Generation is idempotent by re-reading before writing — two concurrent
 * requests during the first minute of federation must not each mint a key and
 * leave the second overwriting the one already published.
 */
export async function ensureKeyPair(
  db: BlogDatabase,
  sessionSecret: string,
): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const existing = await loadFediverseSettings(db);
  if (existing.publicKeyPem && existing.privateKeyCipher) {
    const privateKeyPem = await decryptSecret(existing.privateKeyCipher, sessionSecret);
    if (privateKeyPem) {
      return { publicKeyPem: existing.publicKeyPem, privateKeyPem };
    }
    // Undecryptable: SESSION_SECRET was rotated. A new key is the only way
    // forward, and remote servers will re-fetch it when a signature fails.
    console.warn("Fediverse private key could not be decrypted; generating a new one.");
  }

  const pair = await crypto.subtle.generateKey(KEY_PARAMS, true, ["sign", "verify"]);
  const publicKeyPem = toPem(
    "PUBLIC KEY",
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const privateKeyPem = toPem(
    "PRIVATE KEY",
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );

  await putSetting(db, FEDIVERSE_SETTINGS_KEY, {
    ...existing,
    publicKeyPem,
    privateKeyCipher: await encryptSecret(privateKeyPem, sessionSecret),
  });

  return { publicKeyPem, privateKeyPem };
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    fromPem(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function importPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    fromPem(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/** DER to PEM: base64 in 64-character lines, between the armour. */
export function toPem(label: string, der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = (btoa(binary).match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/**
 * PEM back to DER.
 *
 * The armour lines and *all* whitespace are stripped rather than the newlines
 * alone: keys arrive from other implementations with carriage returns, with
 * no trailing newline, and occasionally re-indented by whatever JSON tooling
 * they passed through.
 */
export function fromPem(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem
    .replace(/-----(BEGIN|END)[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
