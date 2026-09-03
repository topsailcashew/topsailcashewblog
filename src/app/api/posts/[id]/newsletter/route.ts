import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { posts } from "@/db/schema";
import { announceIfPublished } from "@/lib/activitypub/announce";
import { getSessionSecret } from "@/lib/auth";
import { getPostById } from "@/lib/posts";
import {
  loadNewsletterSettings,
  loadSmtpSettings,
  resolveSmtpPassword,
  smtpReady,
} from "@/lib/email/config";
import { ApiError, handle, json, notFound, readJsonBody } from "@/lib/http";
import {
  createSmtpMailer,
  getOrCreateCampaignForPost,
  getPostEmailPerformance,
  loadEmailPost,
  sendCampaignBatch,
  serializeCampaign,
} from "@/lib/newsletter";
import { countSubscribersByStatus } from "@/lib/subscribers";
import { sendNewsletterSchema, uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/newsletter — sends a post to the list.
 *
 * One batch per call, resumable by calling again: the response carries
 * `remaining`, and the editor loops until it is zero. That shape is forced by
 * the runtime — a Worker request cannot hold open hundreds of outbound SMTP
 * connections — but it is also the shape that survives a browser being closed
 * halfway through, because the progress lives in `email_sends` rather than in
 * the request.
 *
 * `mode` decides what happens to the post itself:
 *   publish            — go live, mail nobody
 *   publish_and_email  — go live, then mail the list
 *   email              — mail the list, leave the post where it is
 */
export const POST = handle(async (request: NextRequest, context: RouteContext) => {
  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const { id: rawId } = await context.params;
  const id = uuidSchema.parse(rawId);
  const { mode, batch_size } = sendNewsletterSchema.parse(await readJsonBody(request));

  const db = getDb();

  const post = await loadEmailPost(db, id);
  if (!post) throw notFound("Post");

  if (mode === "publish" || mode === "publish_and_email") {
    await db
      .update(posts)
      .set({
        status: "published",
        // Only stamp a first publication; re-publishing must not move the post
        // back to the top of the feed.
        publishedAt: post.published_at ? new Date(post.published_at) : new Date(),
      })
      .where(eq(posts.id, id));
  }

  if (mode === "publish" || mode === "publish_and_email") {
    // Federation and email are separate audiences reached by the same act of
    // publishing; one failing must not stop the other.
    const published = await getPostById(db, id);
    if (published) await announceIfPublished(db, published, secret);
  }

  if (mode === "publish") {
    return json({ published: true, sent: 0, failed: 0, remaining: 0, errors: [] });
  }

  const settings = await loadNewsletterSettings(db);
  if (!settings.enabled) {
    throw new ApiError(422, "Turn the newsletter on in Settings before sending");
  }

  const counts = await countSubscribersByStatus(db);
  if (counts.subscribed === 0) {
    throw new ApiError(422, "Nobody has confirmed a subscription yet");
  }

  const smtp = await loadSmtpSettings(db);
  if (!smtpReady(smtp)) {
    throw new ApiError(422, "Add SMTP settings before sending");
  }

  const campaign = await getOrCreateCampaignForPost(db, post, settings.footer, {
    // An email-only send has no public page to link to.
    siteLink: mode !== "email",
  });

  const mailer = createSmtpMailer(smtp, await resolveSmtpPassword(smtp, secret));
  const result = await sendCampaignBatch(db, campaign.id, mailer, {
    secret,
    batchSize: batch_size,
  });

  return json({
    published: mode === "publish_and_email",
    campaign: serializeCampaign(campaign),
    ...result,
  });
});

/**
 * GET /api/posts/:id/newsletter — everything the editor's send panel needs.
 *
 * One request rather than three. The panel has to know whether sending is
 * even possible (newsletter on, SMTP configured, anyone to send to) and
 * whether this post has already gone out; asking separately would let the
 * screen render a Send button for a quarter-second before discovering there
 * is nobody to send to.
 */
export const GET = handle(async (_request: NextRequest, context: RouteContext) => {
  const { id: rawId } = await context.params;
  const id = uuidSchema.parse(rawId);
  const db = getDb();

  const [performance, counts, settings, smtp] = await Promise.all([
    getPostEmailPerformance(db, [id]),
    countSubscribersByStatus(db),
    loadNewsletterSettings(db),
    loadSmtpSettings(db),
  ]);

  return json({
    performance: performance.get(id) ?? null,
    audience: counts.subscribed,
    enabled: settings.enabled,
    smtp_ready: smtpReady(smtp),
  });
});
