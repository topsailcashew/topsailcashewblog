import { cache } from "react";
import type { BlogDatabase } from "@/db/client";
import { decryptSecret, encryptSecret, getSetting, putSetting } from "../settings";
import { siteConfig } from "../site";

/**
 * Newsletter and SMTP configuration.
 *
 * Two layers, and the order matters: an environment variable always beats a
 * stored value. That way the settings page is a convenience, not a new place
 * a credential *has* to live — a deployment that sets SMTP_PASSWORD as a
 * Worker secret keeps its password out of the database entirely, and the
 * screen simply shows the field as supplied by the environment.
 */

export const SMTP_SETTINGS_KEY = "smtp";
export const NEWSLETTER_SETTINGS_KEY = "newsletter";

/** How TLS is negotiated. Mirrors what mail providers actually document. */
export const SMTP_SECURITY = ["starttls", "tls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export type SmtpSettings = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  /** Ciphertext. Never returned to a client — see `redactSmtp`. */
  passwordCipher: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
};

export type NewsletterSettings = {
  /** Master switch. Off means the signup form does not render and sends refuse. */
  enabled: boolean;
  /** Shown above the form. */
  pitch: string;
  /** Appended to every email, above the unsubscribe line. */
  footer: string;
  /**
   * Whether a signup must click a confirmation link before it can be mailed.
   *
   * Defaults on and should stay on. A self-hosted sending domain has no
   * reputation to spend; one complaint from an address someone else typed in
   * is expensive in a way it is not for a large provider.
   */
  doubleOptIn: boolean;
};

export const DEFAULT_SMTP: SmtpSettings = {
  host: "",
  port: 587,
  security: "starttls",
  username: "",
  passwordCipher: null,
  fromName: siteConfig.name,
  fromEmail: "",
  replyTo: null,
};

export const DEFAULT_NEWSLETTER: NewsletterSettings = {
  enabled: false,
  pitch: "New writing, sent when it is finished. No schedule, no filler.",
  footer: `You are receiving this because you subscribed at ${siteConfig.name}.`,
  doubleOptIn: true,
};

export async function loadSmtpSettings(db: BlogDatabase): Promise<SmtpSettings> {
  const stored = await getSetting<Partial<SmtpSettings>>(db, SMTP_SETTINGS_KEY);
  const merged = { ...DEFAULT_SMTP, ...(stored ?? {}) };

  // Environment wins, field by field, so a deployment can supply only the
  // password and leave the rest editable on screen.
  return {
    ...merged,
    host: process.env.SMTP_HOST || merged.host,
    port: Number(process.env.SMTP_PORT) || merged.port,
    security: (process.env.SMTP_SECURITY as SmtpSecurity) || merged.security,
    username: process.env.SMTP_USERNAME || merged.username,
    fromEmail: process.env.SMTP_FROM_EMAIL || merged.fromEmail,
    fromName: process.env.SMTP_FROM_NAME || merged.fromName,
  };
}

/**
 * Memoised per request.
 *
 * `SubscribeSection` reads this and now appears in several places on one
 * render — the newsletter page, the end of an article, the search empty state.
 * Without `cache()` each mount is its own round trip to Neon for the same
 * jsonb row. `cache()` is React's request-scoped memo, so it dedupes within a
 * render and never leaks between requests.
 */
export const loadNewsletterSettings = cache(
  async (db: BlogDatabase): Promise<NewsletterSettings> => {
    const stored = await getSetting<Partial<NewsletterSettings>>(
      db,
      NEWSLETTER_SETTINGS_KEY,
    );
    return { ...DEFAULT_NEWSLETTER, ...(stored ?? {}) };
  },
);

export async function saveNewsletterSettings(
  db: BlogDatabase,
  patch: Partial<NewsletterSettings>,
): Promise<NewsletterSettings> {
  const next = { ...(await loadNewsletterSettings(db)), ...patch };
  await putSetting(db, NEWSLETTER_SETTINGS_KEY, next);
  return next;
}

/**
 * Persists SMTP settings, encrypting a newly supplied password and keeping the
 * existing one when the field is left blank.
 *
 * The blank-means-keep rule is what lets the screen round-trip safely: the
 * password is never sent to the browser, so an unchanged form must not be able
 * to erase it by echoing back an empty string.
 */
export async function saveSmtpSettings(
  db: BlogDatabase,
  patch: Partial<Omit<SmtpSettings, "passwordCipher">> & { password?: string | null },
  sessionSecret: string,
): Promise<SmtpSettings> {
  const current = { ...DEFAULT_SMTP, ...((await getSetting<Partial<SmtpSettings>>(db, SMTP_SETTINGS_KEY)) ?? {}) };
  const { password, ...rest } = patch;

  const passwordCipher =
    password === null
      ? null
      : password && password !== ""
        ? await encryptSecret(password, sessionSecret)
        : current.passwordCipher;

  const next: SmtpSettings = { ...current, ...rest, passwordCipher };
  await putSetting(db, SMTP_SETTINGS_KEY, next);
  return next;
}

/** The password in the clear, for the sender only. */
export async function resolveSmtpPassword(
  smtp: SmtpSettings,
  sessionSecret: string,
): Promise<string | null> {
  if (process.env.SMTP_PASSWORD) return process.env.SMTP_PASSWORD;
  return decryptSecret(smtp.passwordCipher, sessionSecret);
}

/** What the admin API is allowed to return: everything except the credential. */
export type RedactedSmtp = Omit<SmtpSettings, "passwordCipher"> & {
  has_password: boolean;
  /** True when the environment supplies it, so the screen can say so. */
  password_from_env: boolean;
};

export function redactSmtp(smtp: SmtpSettings): RedactedSmtp {
  const { passwordCipher, ...rest } = smtp;
  return {
    ...rest,
    has_password: Boolean(passwordCipher) || Boolean(process.env.SMTP_PASSWORD),
    password_from_env: Boolean(process.env.SMTP_PASSWORD),
  };
}

/** Whether the configuration is complete enough to attempt a send. */
export function smtpReady(smtp: SmtpSettings): boolean {
  return smtp.host !== "" && smtp.fromEmail !== "" && smtp.port > 0;
}
