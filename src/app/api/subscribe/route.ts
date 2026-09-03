import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { loadNewsletterSettings, loadSmtpSettings, resolveSmtpPassword, smtpReady } from "@/lib/email/config";
import { createConfirmToken } from "@/lib/email/tokens";
import { renderConfirmationEmail } from "@/lib/email/render";
import { ApiError, handle, json, readJsonBody } from "@/lib/http";
import { createSmtpMailer } from "@/lib/newsletter";
import { absoluteUrl } from "@/lib/site";
import { confirmSubscriber, subscribe } from "@/lib/subscribers";
import { HONEYPOT_FIELD, subscribeSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * POST /api/subscribe — the one public write besides comments.
 *
 * Always answers the same way. "Check your inbox" is returned whether the
 * address was new, already subscribed, previously unsubscribed or on the
 * suppression list, because any difference here is a membership oracle: type
 * an address in, read the response, learn whether that person reads this blog.
 */
export const POST = handle(async (request: NextRequest) => {
  const body = subscribeSchema.parse(await readJsonBody(request));
  const db = getDb();

  const settings = await loadNewsletterSettings(db);
  if (!settings.enabled) {
    throw new ApiError(404, "The newsletter is not open for signups");
  }

  const accepted = { ok: true, message: "Check your inbox to confirm." } as const;

  // A filled honeypot is accepted with the normal response and then dropped,
  // so an automated client learns nothing about what caught it.
  if (typeof body[HONEYPOT_FIELD] === "string" && body[HONEYPOT_FIELD] !== "") {
    return json(accepted, 202);
  }

  const result = await subscribe(db, {
    email: body.email,
    name: body.name,
    source: "form",
    utm_source: body.utm_source,
    utm_medium: body.utm_medium,
    utm_campaign: body.utm_campaign,
    utm_term: body.utm_term,
    utm_content: body.utm_content,
    referrer_host: hostOf(body.referrer ?? null),
    landing_path: body.landing_path,
  });

  // Single opt-in: no confirmation to send, so mark them subscribed here.
  if (!settings.doubleOptIn && result.subscriber.status === "pending") {
    await confirmSubscriber(db, result.subscriber.id);
    return json({ ok: true, message: "You are on the list." }, 202);
  }

  if (result.subscriber.status === "pending") {
    await sendConfirmation(db, result.subscriber.id, result.subscriber.email);
  }

  return json(accepted, 202);
});

/**
 * Best effort by design.
 *
 * The row is already committed. Failing the request because SMTP is
 * misconfigured would tell a reader their signup did not work when it did,
 * and they would have no way to retry into a state that helps.
 */
async function sendConfirmation(
  db: ReturnType<typeof getDb>,
  subscriberId: string,
  email: string,
): Promise<void> {
  try {
    const secret = getSessionSecret();
    if (!secret) return;

    const smtp = await loadSmtpSettings(db);
    if (!smtpReady(smtp)) {
      console.warn("Signup stored but SMTP is not configured; no confirmation sent.");
      return;
    }

    const token = await createConfirmToken(subscriberId, secret);
    const rendered = renderConfirmationEmail(absoluteUrl(`/newsletter/confirm?t=${token}`));
    const mailer = createSmtpMailer(smtp, await resolveSmtpPassword(smtp, secret));

    await mailer({
      to: { email },
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: { "Auto-Submitted": "auto-generated" },
    });
  } catch (error) {
    console.warn("Could not send the confirmation email:", error);
  }
}

/** Origin only. A full referring URL can carry a query string with PII in it. */
function hostOf(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).host || null;
  } catch {
    return null;
  }
}
