import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import {
  emailCampaigns,
  emailSends,
  posts,
  subscribers,
  type EmailCampaignRow,
} from "@/db/schema";
import { ApiError, notFound } from "./http";
import { absoluteUrl, siteConfig } from "./site";
import { recordEvent, rowsOf, toMetrics, type SubscriberMetrics } from "./subscribers";
import type { SmtpSettings } from "./email/config";
import { buildMessageId, buildMimeMessage, type MailAddress } from "./email/mime";
import { sendViaSmtp, type SmtpConnect } from "./email/smtp";
import {
  createClickToken,
  createOpenToken,
  createUnsubscribeToken,
} from "./email/tokens";
import {
  personalizeHtml,
  personalizeText,
  renderPostEmail,
  type EmailPost,
} from "./email/render";

/**
 * Sending the list.
 *
 * The unit of work is `email_sends`: one row per (campaign, subscriber), with
 * a unique constraint on the pair. That single constraint is what makes the
 * whole thing safe to interrupt — a send that dies halfway leaves rows for
 * everyone already mailed, and re-running picks up exactly the recipients who
 * have no row yet. There is no queue to drain and no cursor to lose.
 */

/**
 * How many recipients one call attempts.
 *
 * Bounded by the Worker's subrequest allowance, not by anything about email:
 * each message is its own TCP connection, and a request that tried to open
 * hundreds would be cut off partway with no record of where it stopped. The
 * caller loops until `remaining` reaches zero.
 */
export const DEFAULT_BATCH_SIZE = 25;

/**
 * The abstraction a transport plugs into.
 *
 * SMTP is what ships (see ./email/smtp), because that is what lets this point
 * at any provider without a client library for each. An HTTP provider API —
 * Postmark's /email, SES's SendEmail — would be a second implementation of
 * this one function and nothing else.
 */
export type Mailer = (message: {
  to: MailAddress;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}) => Promise<void>;

export function createSmtpMailer(
  smtp: SmtpSettings,
  password: string | null,
  connect?: SmtpConnect,
): Mailer {
  const from: MailAddress = { name: smtp.fromName, email: smtp.fromEmail };

  return async (message) => {
    const messageId = buildMessageId(smtp.fromEmail);
    const raw = buildMimeMessage(
      {
        from,
        to: message.to,
        replyTo: smtp.replyTo ? { email: smtp.replyTo } : null,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
      },
      messageId,
    );

    await sendViaSmtp(
      {
        host: smtp.host,
        port: smtp.port,
        security: smtp.security,
        username: smtp.username || undefined,
        password,
        connect,
      },
      { from: smtp.fromEmail, to: message.to.email, raw },
    );
  };
}

/* --- campaigns ----------------------------------------------------------- */

export type SerializedCampaign = {
  id: string;
  post_id: string | null;
  subject: string;
  status: string;
  recipient_count: number;
  error: string | null;
  sent_at: string | null;
  created_at: string;
};

export function serializeCampaign(row: EmailCampaignRow): SerializedCampaign {
  return {
    id: row.id,
    post_id: row.postId,
    subject: row.subject,
    status: row.status,
    recipient_count: row.recipientCount,
    error: row.error,
    sent_at: iso(row.sentAt),
    created_at: iso(row.createdAt) ?? "",
  };
}

/**
 * The campaign for a post, creating it on first use.
 *
 * The body is snapshotted here and never re-rendered. Once an email has left,
 * editing the post must not change what the archive says was sent — and more
 * practically, a resumed send has to put the same words in front of the second
 * half of the list as the first half already received.
 */
export async function getOrCreateCampaignForPost(
  db: BlogDatabase,
  post: EmailPost & { id: string },
  footer: string,
  options: { siteLink?: boolean } = {},
): Promise<EmailCampaignRow> {
  const [existing] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.postId, post.id))
    .orderBy(desc(emailCampaigns.createdAt))
    .limit(1);
  if (existing) return existing;

  const rendered = renderPostEmail(post, { footer, siteLink: options.siteLink });
  const [row] = await db
    .insert(emailCampaigns)
    .values({
      postId: post.id,
      subject: rendered.subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      status: "draft",
    })
    .returning();
  return row;
}

export async function getCampaign(
  db: BlogDatabase,
  id: string,
): Promise<EmailCampaignRow | null> {
  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  return row ?? null;
}

export async function listCampaigns(
  db: BlogDatabase,
  limit = 30,
): Promise<SerializedCampaign[]> {
  const rows = await db
    .select()
    .from(emailCampaigns)
    .orderBy(desc(emailCampaigns.createdAt))
    .limit(limit);
  return rows.map(serializeCampaign);
}

/**
 * Signed click-through URLs for every outbound link in a body, for one send.
 *
 * Built as a lookup table rather than signed inline because HMAC is async and
 * the link rewrite happens inside a synchronous `String.replace`. Signing each
 * distinct URL once per recipient is also fewer HMACs than signing the same
 * link every time it appears.
 */
export async function buildClickTokens(
  bodyHtml: string,
  sendId: string,
  secret: string,
): Promise<Map<string, string>> {
  const urls = new Set<string>();
  for (const match of bodyHtml.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    urls.add(match[1]);
  }

  const table = new Map<string, string>();
  for (const url of urls) {
    table.set(url, absoluteUrl(`/e/c/${await createClickToken(sendId, url, secret)}`));
  }
  return table;
}

export type SendBatchResult = {
  sent: number;
  failed: number;
  /** Confirmed subscribers still without a send row for this campaign. */
  remaining: number;
  errors: string[];
};

/**
 * Mails the next batch of recipients.
 *
 * Recipients are found by anti-join rather than by paging an offset: "everyone
 * confirmed who has no row for this campaign". An offset would drift the
 * moment somebody subscribed mid-send, and could then skip or double a
 * recipient.
 *
 * Each send commits on its own. That is deliberately not transactional — the
 * message is already gone by the time the row is written, so the row must
 * survive whatever happens to the rest of the batch.
 */
export async function sendCampaignBatch(
  db: BlogDatabase,
  campaignId: string,
  mailer: Mailer,
  options: { secret: string; batchSize?: number },
): Promise<SendBatchResult> {
  const campaign = await getCampaign(db, campaignId);
  if (!campaign) throw notFound("Campaign");
  if (!campaign.bodyHtml) throw new ApiError(422, "Campaign has no body to send");

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const bodyHtml = campaign.bodyHtml;

  const batch = await db
    .select({ id: subscribers.id, email: subscribers.email, name: subscribers.name })
    .from(subscribers)
    .leftJoin(
      emailSends,
      and(
        eq(emailSends.subscriberId, subscribers.id),
        eq(emailSends.campaignId, campaignId),
      ),
    )
    .where(and(eq(subscribers.status, "subscribed"), isNull(emailSends.id)))
    .orderBy(subscribers.createdAt)
    .limit(batchSize);

  if (batch.length === 0) {
    await db
      .update(emailCampaigns)
      .set({ status: "sent", sentAt: campaign.sentAt ?? new Date() })
      .where(eq(emailCampaigns.id, campaignId));
    return { sent: 0, failed: 0, remaining: 0, errors: [] };
  }

  if (campaign.status === "draft") {
    await db
      .update(emailCampaigns)
      .set({ status: "sending" })
      .where(eq(emailCampaigns.id, campaignId));
  }

  const result: SendBatchResult = { sent: 0, failed: 0, remaining: 0, errors: [] };

  for (const recipient of batch) {
    /*
      The send row is written *before* the message goes out.

      Written after, a crash mid-send would leave no record and the next batch
      would mail the same person again. Written first, the worst case is a row
      still marked queued for a message that never left — visible on the
      campaign screen, and not a duplicate in somebody's inbox.
    */
    const [send] = await db
      .insert(emailSends)
      .values({ campaignId, subscriberId: recipient.id, status: "queued" })
      .onConflictDoNothing()
      .returning();
    if (!send) continue; // Raced with another batch; that recipient is theirs.

    // /e/u rather than the reader-facing page: it has to answer both a human
    // GET and the machine POST that List-Unsubscribe-Post sends, and a page
    // component can only do the first.
    const unsubscribeUrl = absoluteUrl(
      `/e/u?t=${await createUnsubscribeToken(recipient.id, options.secret)}`,
    );
    const pixelUrl = absoluteUrl(`/e/o/${await createOpenToken(send.id, options.secret)}`);

    try {
      const links = await buildClickTokens(bodyHtml, send.id, options.secret);
      const html = personalizeHtml(bodyHtml, {
        unsubscribeUrl,
        pixelUrl,
        trackLink: (url) => links.get(url) ?? url,
      });

      await mailer({
        to: { name: recipient.name, email: recipient.email },
        subject: campaign.subject,
        html,
        text: personalizeText(campaign.bodyText ?? "", unsubscribeUrl),
        headers: {
          // RFC 8058. The header pair is what makes a mail client show its own
          // one-click unsubscribe control instead of a "report spam" button,
          // which is the highest-leverage thing a small sender can do for
          // deliverability.
          "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${siteConfig.contactEmail}?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "List-Id": `${siteConfig.name} <newsletter.${hostOf()}>`,
          "Auto-Submitted": "auto-generated",
        },
      });

      await db
        .update(emailSends)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(emailSends.id, send.id));
      await recordEvent(db, recipient.id, "sent", { sendId: send.id });
      result.sent += 1;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Send failed";
      await db
        .update(emailSends)
        .set({ status: "failed", error: message.slice(0, 500) })
        .where(eq(emailSends.id, send.id));
      result.failed += 1;
      if (result.errors.length < 5) result.errors.push(`${recipient.email}: ${message}`);
    }
  }

  const [remaining] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(subscribers)
    .leftJoin(
      emailSends,
      and(
        eq(emailSends.subscriberId, subscribers.id),
        eq(emailSends.campaignId, campaignId),
      ),
    )
    .where(and(eq(subscribers.status, "subscribed"), isNull(emailSends.id)));
  result.remaining = remaining?.value ?? 0;

  const [counted] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(emailSends)
    .where(eq(emailSends.campaignId, campaignId));

  await db
    .update(emailCampaigns)
    .set({
      recipientCount: counted?.value ?? 0,
      ...(result.remaining === 0
        ? { status: "sent" as const, sentAt: campaign.sentAt ?? new Date() }
        : {}),
    })
    .where(eq(emailCampaigns.id, campaignId));

  return result;
}

/* --- engagement ---------------------------------------------------------- */

/**
 * Records an open.
 *
 * `opened_at` is set only on the first one, via `coalesce`, so the timestamp
 * is when they read it rather than when their client last re-fetched images;
 * `open_count` carries the total. One statement, so there is no window in
 * which a concurrent open could re-stamp the first.
 */
export async function recordOpen(db: BlogDatabase, sendId: string): Promise<void> {
  const [row] = await db
    .update(emailSends)
    .set({
      openedAt: sql`coalesce(${emailSends.openedAt}, now())`,
      openCount: sql`${emailSends.openCount} + 1`,
    })
    .where(eq(emailSends.id, sendId))
    .returning({ subscriberId: emailSends.subscriberId });
  if (row) await recordEvent(db, row.subscriberId, "opened", { sendId });
}

/**
 * Records a click.
 *
 * A click implies an open even when the pixel never loaded — which is most of
 * the time, now that clients block remote images by default. Setting both here
 * is what keeps CTOR from exceeding 100%.
 */
export async function recordClick(
  db: BlogDatabase,
  sendId: string,
  url: string,
): Promise<void> {
  const [row] = await db
    .update(emailSends)
    .set({
      clickedAt: sql`coalesce(${emailSends.clickedAt}, now())`,
      clickCount: sql`${emailSends.clickCount} + 1`,
      openedAt: sql`coalesce(${emailSends.openedAt}, now())`,
    })
    .where(eq(emailSends.id, sendId))
    .returning({ subscriberId: emailSends.subscriberId });
  if (row) await recordEvent(db, row.subscriberId, "clicked", { sendId, url });
}

/* --- reporting ----------------------------------------------------------- */

export type CampaignMetrics = SubscriberMetrics & {
  campaign_id: string;
  post_id: string | null;
  subject: string;
  sent_at: string | null;
};

/** Per-campaign rates, newest first. */
export async function getCampaignMetrics(
  db: BlogDatabase,
  limit = 20,
): Promise<CampaignMetrics[]> {
  const rows = await db
    .select({
      campaignId: emailCampaigns.id,
      postId: emailCampaigns.postId,
      subject: emailCampaigns.subject,
      sentAt: emailCampaigns.sentAt,
      delivered: sql<number>`count(${emailSends.id}) filter (where ${emailSends.status} = 'sent')::int`,
      failed: sql<number>`count(${emailSends.id}) filter (where ${emailSends.status} = 'failed')::int`,
      opened: sql<number>`count(${emailSends.id}) filter (where ${emailSends.openedAt} is not null)::int`,
      clicked: sql<number>`count(${emailSends.id}) filter (where ${emailSends.clickedAt} is not null)::int`,
      totalOpens: sql<number>`coalesce(sum(${emailSends.openCount}), 0)::int`,
      totalClicks: sql<number>`coalesce(sum(${emailSends.clickCount}), 0)::int`,
    })
    .from(emailCampaigns)
    .leftJoin(emailSends, eq(emailSends.campaignId, emailCampaigns.id))
    .groupBy(
      emailCampaigns.id,
      emailCampaigns.postId,
      emailCampaigns.subject,
      emailCampaigns.sentAt,
    )
    .orderBy(desc(emailCampaigns.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    campaign_id: row.campaignId,
    post_id: row.postId,
    subject: row.subject,
    sent_at: iso(row.sentAt),
    ...toMetrics(row),
  }));
}

export type PostEmailPerformance = {
  post_id: string;
  campaign_id: string;
  delivered: number;
  open_rate: number | null;
  ctor: number | null;
};

/** Rates for a specific set of posts, for the Recent articles table. */
export async function getPostEmailPerformance(
  db: BlogDatabase,
  postIds: string[],
): Promise<Map<string, PostEmailPerformance>> {
  if (postIds.length === 0) return new Map();

  const rows = await db
    .select({
      postId: emailCampaigns.postId,
      campaignId: emailCampaigns.id,
      delivered: sql<number>`count(${emailSends.id}) filter (where ${emailSends.status} = 'sent')::int`,
      opened: sql<number>`count(${emailSends.id}) filter (where ${emailSends.openedAt} is not null)::int`,
      clicked: sql<number>`count(${emailSends.id}) filter (where ${emailSends.clickedAt} is not null)::int`,
    })
    .from(emailCampaigns)
    .leftJoin(emailSends, eq(emailSends.campaignId, emailCampaigns.id))
    .where(inArray(emailCampaigns.postId, postIds))
    .groupBy(emailCampaigns.postId, emailCampaigns.id);

  const byPost = new Map<string, PostEmailPerformance>();
  for (const row of rows) {
    if (!row.postId) continue;
    byPost.set(row.postId, {
      post_id: row.postId,
      campaign_id: row.campaignId,
      delivered: row.delivered,
      open_rate: row.delivered > 0 ? row.opened / row.delivered : null,
      ctor: row.opened > 0 ? row.clicked / row.opened : null,
    });
  }
  return byPost;
}

export type RollingAverage = {
  campaigns: number;
  open_rate: number | null;
  ctor: number | null;
};

/**
 * The rolling average of the last `window` campaigns.
 *
 * A rate on its own says nothing — 41% is excellent for one list and poor for
 * another. The comparison that means something is against this blog's own
 * recent baseline, which is what every post row is measured against.
 *
 * Averaged per campaign rather than pooled over all sends, so one large send
 * does not swamp the baseline the smaller ones are judged by.
 */
export async function getRollingAverage(
  db: BlogDatabase,
  window = 10,
): Promise<RollingAverage> {
  const result = await db.execute(sql`
    with per_campaign as (
      select
        c.id,
        count(s.id) filter (where s.status = 'sent') as delivered,
        count(s.id) filter (where s.opened_at is not null) as opened,
        count(s.id) filter (where s.clicked_at is not null) as clicked
      from email_campaigns c
      join email_sends s on s.campaign_id = c.id
      where c.sent_at is not null
      group by c.id, c.sent_at
      order by c.sent_at desc
      limit ${window}
    )
    select
      count(*)::int as campaigns,
      avg(opened::numeric / nullif(delivered, 0))::float8 as open_rate,
      avg(clicked::numeric / nullif(opened, 0))::float8 as ctor
    from per_campaign
  `);

  const row = rowsOf<{
    campaigns: number;
    open_rate: number | null;
    ctor: number | null;
  }>(result)[0];

  return {
    campaigns: Number(row?.campaigns ?? 0),
    open_rate: numberOrNull(row?.open_rate),
    ctor: numberOrNull(row?.ctor),
  };
}

/** The post behind a campaign, in the shape the renderer wants. */
export async function loadEmailPost(
  db: BlogDatabase,
  postId: string,
): Promise<(EmailPost & { id: string }) | null> {
  const [row] = await db
    .select({
      id: posts.id,
      title: posts.title,
      slug: posts.slug,
      excerpt: posts.excerpt,
      content_html: posts.contentHtml,
      cover_image_url: posts.coverImageUrl,
      published_at: posts.publishedAt,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!row) return null;
  return { ...row, published_at: iso(row.published_at) };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hostOf(): string {
  try {
    return new URL(absoluteUrl("/")).host || "localhost";
  } catch {
    return "localhost";
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
