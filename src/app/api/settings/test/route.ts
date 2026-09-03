import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import {
  loadSmtpSettings,
  resolveSmtpPassword,
  smtpReady,
} from "@/lib/email/config";
import { ApiError, handle, json, readJsonBody } from "@/lib/http";
import { createSmtpMailer } from "@/lib/newsletter";
import { siteConfig } from "@/lib/site";
import { sendTestSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/test — proves the SMTP settings before a real send.
 *
 * Worth its own endpoint. Discovering that a password is wrong halfway through
 * mailing the list is expensive in a way that cannot be undone; discovering it
 * from one test message costs nothing.
 */
export const POST = handle(async (request: NextRequest) => {
  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const { to } = sendTestSchema.parse(await readJsonBody(request));
  const db = getDb();

  const smtp = await loadSmtpSettings(db);
  if (!smtpReady(smtp)) {
    throw new ApiError(422, "Set a host and a from-address before testing");
  }

  const mailer = createSmtpMailer(smtp, await resolveSmtpPassword(smtp, secret));

  try {
    await mailer({
      to: { email: to },
      subject: `Test from ${siteConfig.name}`,
      html: `<p style="font:400 16px/1.6 Georgia,serif">If you are reading this, ${escapeHtml(smtp.host)} accepted a message from ${escapeHtml(smtp.fromEmail)} and delivered it. The newsletter is ready to send.</p>`,
      text: `If you are reading this, ${smtp.host} accepted a message from ${smtp.fromEmail} and delivered it. The newsletter is ready to send.`,
      headers: { "Auto-Submitted": "auto-generated" },
    });
  } catch (cause) {
    // The SMTP conversation's own error text is the useful part — "535
    // authentication failed" tells you what to fix, "could not send" does not.
    throw new ApiError(
      502,
      cause instanceof Error ? cause.message : "The mail server refused the message",
    );
  }

  return json({ ok: true, sent_to: to });
});

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
