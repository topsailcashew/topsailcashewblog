import { cache } from "react";
import type { BlogDatabase } from "@/db/client";
import { decryptSecret, encryptSecret, getSetting, putSetting } from "../settings";

/**
 * Gemini configuration.
 *
 * A line-for-line mirror of `src/lib/email/config.ts`, and deliberately so:
 * that file already worked out the tri-state credential save, the
 * env-wins-per-field load, and the redaction that makes leaking the secret
 * structurally impossible. Two subsystems storing a credential two different
 * ways is how one of them ends up wrong.
 *
 * Model ids are settings rather than constants. "Nano Banana" is a marketing
 * name over an id that has already moved once; making it a setting means a
 * rename is an edit on a screen rather than a deploy, and it means the three
 * call sites cannot disagree about which model they are using.
 *
 * No migration: `settings` is one jsonb row per group.
 */

export const AI_SETTINGS_KEY = "ai";

export type AiSettings = {
  /** Master switch. Off means every panel button is disabled. */
  enabled: boolean;
  /** Ciphertext. Never returned to a client — see `redactAi`. */
  apiKeyCipher: string | null;
  textModel: string;
  imageModel: string;
};

export const DEFAULT_AI: AiSettings = {
  enabled: false,
  apiKeyCipher: null,
  textModel: "gemini-2.5-flash",
  // "Nano Banana".
  imageModel: "gemini-2.5-flash-image",
};

export const loadAiSettings = cache(
  async (db: BlogDatabase): Promise<AiSettings> => {
    const stored = await getSetting<Partial<AiSettings>>(db, AI_SETTINGS_KEY);
    const merged = { ...DEFAULT_AI, ...(stored ?? {}) };

    // Environment wins field by field, so a deployment can pin the model
    // without taking the rest off the settings screen.
    return {
      ...merged,
      textModel: process.env.GEMINI_TEXT_MODEL || merged.textModel,
      imageModel: process.env.GEMINI_IMAGE_MODEL || merged.imageModel,
    };
  },
);

/**
 * Persists settings, encrypting a newly supplied key and keeping the existing
 * one when the field is left blank.
 *
 * The blank-means-keep rule is what lets the screen round-trip safely: the key
 * is never sent to the browser, so an unchanged form must not be able to erase
 * it by echoing back an empty string.
 */
export async function saveAiSettings(
  db: BlogDatabase,
  patch: Partial<Omit<AiSettings, "apiKeyCipher">> & { apiKey?: string | null },
  sessionSecret: string,
): Promise<AiSettings> {
  const current = {
    ...DEFAULT_AI,
    ...((await getSetting<Partial<AiSettings>>(db, AI_SETTINGS_KEY)) ?? {}),
  };
  const { apiKey, ...rest } = patch;

  const apiKeyCipher =
    apiKey === null
      ? null
      : apiKey && apiKey !== ""
        ? await encryptSecret(apiKey, sessionSecret)
        : current.apiKeyCipher;

  const next: AiSettings = { ...current, ...rest, apiKeyCipher };
  await putSetting(db, AI_SETTINGS_KEY, next);
  return next;
}

/** The key in the clear, for the server only. */
export async function resolveGeminiKey(
  ai: AiSettings,
  sessionSecret: string,
): Promise<string | null> {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  return decryptSecret(ai.apiKeyCipher, sessionSecret);
}

/** What the admin API may return: everything except the credential. */
export type RedactedAi = Omit<AiSettings, "apiKeyCipher"> & {
  has_key: boolean;
  key_from_env: boolean;
};

export function redactAi(ai: AiSettings): RedactedAi {
  const { apiKeyCipher, ...rest } = ai;
  return {
    ...rest,
    has_key: Boolean(apiKeyCipher) || Boolean(process.env.GEMINI_API_KEY),
    key_from_env: Boolean(process.env.GEMINI_API_KEY),
  };
}

/** Whether a key exists at all, regardless of the switch. */
export function aiConfigured(ai: AiSettings): boolean {
  return Boolean(ai.apiKeyCipher) || Boolean(process.env.GEMINI_API_KEY);
}

/** Whether a call may actually be made. */
export function aiReady(ai: AiSettings): boolean {
  return ai.enabled && aiConfigured(ai);
}
