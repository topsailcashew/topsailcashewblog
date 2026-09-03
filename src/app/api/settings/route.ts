import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import {
  loadNewsletterSettings,
  loadSmtpSettings,
  redactSmtp,
  saveNewsletterSettings,
  saveSmtpSettings,
} from "@/lib/email/config";
import { ApiError, handle, json, readJsonBody } from "@/lib/http";
import {
  aiSettingsSchema,
  fediverseSettingsSchema,
  newsletterSettingsSchema,
  smtpSettingsSchema,
} from "@/lib/validation";
import { handle as fediverseHandle } from "@/lib/activitypub/actor";
import {
  loadFediverseSettings,
  saveFediverseSettings,
} from "@/lib/activitypub/keys";
import { countFollowers } from "@/lib/activitypub/delivery";
import { loadAiSettings, redactAi, saveAiSettings } from "@/lib/ai/config";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    smtp: smtpSettingsSchema.optional(),
    newsletter: newsletterSettingsSchema.optional(),
    fediverse: fediverseSettingsSchema.optional(),
    ai: aiSettingsSchema.optional(),
  })
  .refine(
    (body) => body.smtp || body.newsletter || body.fediverse || body.ai,
    "Provide a settings group",
  );

/**
 * Everything the settings screen shows, minus anything secret.
 *
 * The SMTP password and the fediverse private key are both stored encrypted
 * and neither is ever returned — the screen gets a boolean and the handle, and
 * that is all it needs to render.
 */
async function readAll(db: ReturnType<typeof getDb>) {
  const [smtp, newsletter, fediverse, followers, ai] = await Promise.all([
    loadSmtpSettings(db),
    loadNewsletterSettings(db),
    loadFediverseSettings(db),
    countFollowers(db).catch(() => 0),
    loadAiSettings(db),
  ]);

  return {
    smtp: redactSmtp(smtp),
    newsletter,
    fediverse: {
      enabled: fediverse.enabled,
      username: fediverse.username,
      summary: fediverse.summary,
      handle: `@${fediverseHandle(fediverse)}`,
      has_key: Boolean(fediverse.publicKeyPem),
      followers,
    },
    ai: redactAi(ai),
  };
}

/** GET /api/settings — everything except the credentials, which never leave. */
export const GET = handle(async () => json(await readAll(getDb())));

export const PUT = handle(async (request: NextRequest) => {
  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const body = bodySchema.parse(await readJsonBody(request));
  const db = getDb();

  if (body.newsletter) {
    await saveNewsletterSettings(db, {
      enabled: body.newsletter.enabled,
      pitch: body.newsletter.pitch,
      footer: body.newsletter.footer,
      doubleOptIn: body.newsletter.double_opt_in,
    });
  }

  if (body.fediverse) {
    await saveFediverseSettings(db, body.fediverse);
  }

  if (body.ai) {
    await saveAiSettings(
      db,
      {
        enabled: body.ai.enabled,
        textModel: body.ai.text_model,
        imageModel: body.ai.image_model,
        // Absent or empty means "keep what is stored" — the form never
        // receives the key, so an untouched field must not clear it.
        apiKey: body.ai.api_key === undefined ? undefined : body.ai.api_key,
      },
      secret,
    );
  }

  if (body.smtp) {
    await saveSmtpSettings(
      db,
      {
        host: body.smtp.host,
        port: body.smtp.port,
        security: body.smtp.security,
        username: body.smtp.username,
        fromName: body.smtp.from_name,
        fromEmail: body.smtp.from_email,
        replyTo: body.smtp.reply_to || null,
        // Absent or empty means "keep what is stored" — the form never
        // receives the password, so an untouched field must not clear it.
        password: body.smtp.password === undefined ? undefined : body.smtp.password,
      },
      secret,
    );
  }

  return json(await readAll(db));
});
