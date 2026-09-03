import { and, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import {
  emailSends,
  subscriberEvents,
  subscribers,
  type SubscriberEventType,
  type SubscriberRow,
  type SubscriberStatus,
} from "@/db/schema";
import { ApiError, notFound } from "./http";

/**
 * The audience.
 *
 * One table of addresses plus an append-only event log. Everything the
 * analytics screens show is derived from those two — there is no counter
 * anywhere that has to be kept in step, which means no number on any screen
 * can disagree with the underlying rows.
 */

export type SerializedSubscriber = {
  id: string;
  email: string;
  name: string | null;
  status: SubscriberStatus;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  source: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  referrer_host: string | null;
  landing_path: string | null;
  created_at: string;
};

export function serializeSubscriber(row: SubscriberRow): SerializedSubscriber {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    confirmed_at: iso(row.confirmedAt),
    unsubscribed_at: iso(row.unsubscribedAt),
    source: row.source,
    utm_source: row.utmSource,
    utm_medium: row.utmMedium,
    utm_campaign: row.utmCampaign,
    utm_term: row.utmTerm,
    utm_content: row.utmContent,
    referrer_host: row.referrerHost,
    landing_path: row.landingPath,
    created_at: iso(row.createdAt) ?? "",
  };
}

export type SubscribeInput = {
  email: string;
  name?: string | null;
  source?: string;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
  referrer_host?: string | null;
  landing_path?: string | null;
};

export type SubscribeResult = {
  subscriber: SubscriberRow;
  /** False when the address was already on the list in some form. */
  created: boolean;
  /** True when this call moved them back from unsubscribed. */
  resubscribed: boolean;
};

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Adds an address, or brings a lapsed one back.
 *
 * Deliberately idempotent and deliberately quiet about which case it hit. A
 * public signup form that answered "you are already subscribed" differently
 * from "thanks, check your inbox" would be a membership oracle for any address
 * someone cared to type in; the route says the same thing either way, and this
 * returns the distinction only so the caller knows whether to send mail.
 *
 * Attribution is written on insert only. A returning subscriber's original
 * source is the true one — overwriting it with wherever they happened to be
 * standing the second time would quietly rewrite every channel report.
 */
export async function subscribe(
  db: BlogDatabase,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const email = normalizeEmail(input.email);
  if (email === "" || !email.includes("@")) {
    throw new ApiError(422, "That does not look like an email address");
  }

  const [existing] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.email, email))
    .limit(1);

  if (existing) {
    // A bounced or complained address is left exactly where it is. Re-adding
    // it because someone typed it into the form again is how a sending domain
    // gets itself blocked.
    if (existing.status === "bounced" || existing.status === "complained") {
      return { subscriber: existing, created: false, resubscribed: false };
    }
    if (existing.status === "unsubscribed") {
      const [row] = await db
        .update(subscribers)
        .set({ status: "pending", unsubscribedAt: null, confirmedAt: null })
        .where(eq(subscribers.id, existing.id))
        .returning();
      await recordEvent(db, row.id, "subscribed");
      return { subscriber: row, created: false, resubscribed: true };
    }
    return { subscriber: existing, created: false, resubscribed: false };
  }

  const [row] = await db
    .insert(subscribers)
    .values({
      email,
      name: emptyToNull(input.name),
      status: "pending",
      source: input.source ?? "form",
      utmSource: emptyToNull(input.utm_source),
      utmMedium: emptyToNull(input.utm_medium),
      utmCampaign: emptyToNull(input.utm_campaign),
      utmTerm: emptyToNull(input.utm_term),
      utmContent: emptyToNull(input.utm_content),
      referrerHost: emptyToNull(input.referrer_host),
      landingPath: emptyToNull(input.landing_path),
    })
    .returning();

  await recordEvent(db, row.id, "subscribed");
  return { subscriber: row, created: true, resubscribed: false };
}

/** Marks a pending signup as confirmed. Idempotent. */
export async function confirmSubscriber(
  db: BlogDatabase,
  id: string,
): Promise<SubscriberRow | null> {
  const [row] = await db
    .update(subscribers)
    .set({ status: "subscribed", confirmedAt: sql`coalesce(${subscribers.confirmedAt}, now())` })
    .where(eq(subscribers.id, id))
    .returning();
  if (!row) return null;
  await recordEvent(db, row.id, "confirmed");
  return row;
}

/** Removes an address from the list. Idempotent, and never fails loudly. */
export async function unsubscribeSubscriber(
  db: BlogDatabase,
  id: string,
): Promise<SubscriberRow | null> {
  const [row] = await db
    .update(subscribers)
    .set({ status: "unsubscribed", unsubscribedAt: new Date() })
    .where(eq(subscribers.id, id))
    .returning();
  if (!row) return null;
  await recordEvent(db, row.id, "unsubscribed");
  return row;
}

/** Admin-side removal: the row goes, and its sends and events with it. */
export async function deleteSubscriber(db: BlogDatabase, id: string): Promise<void> {
  const removed = await db
    .delete(subscribers)
    .where(eq(subscribers.id, id))
    .returning({ id: subscribers.id });
  if (removed.length === 0) throw notFound("Subscriber");
}

export async function recordEvent(
  db: BlogDatabase,
  subscriberId: string,
  type: SubscriberEventType,
  extra: { sendId?: string; url?: string } = {},
): Promise<void> {
  await db.insert(subscriberEvents).values({
    subscriberId,
    type,
    sendId: extra.sendId ?? null,
    url: extra.url ?? null,
  });
}

export async function getSubscriber(
  db: BlogDatabase,
  id: string,
): Promise<SubscriberRow | null> {
  const [row] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, id))
    .limit(1);
  return row ?? null;
}

export async function listSubscribers(
  db: BlogDatabase,
  options: {
    status?: SubscriberStatus;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<SerializedSubscriber[]> {
  const term = options.search?.trim();
  const rows = await db
    .select()
    .from(subscribers)
    .where(
      and(
        options.status ? eq(subscribers.status, options.status) : undefined,
        term
          ? or(
              ilike(subscribers.email, `%${term}%`),
              ilike(subscribers.name, `%${term}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(subscribers.createdAt))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);
  return rows.map(serializeSubscriber);
}

export type SubscriberCounts = Record<SubscriberStatus, number> & { total: number };

export async function countSubscribersByStatus(
  db: BlogDatabase,
): Promise<SubscriberCounts> {
  const rows = await db
    .select({ status: subscribers.status, value: sql<number>`count(*)::int` })
    .from(subscribers)
    .groupBy(subscribers.status);

  const counts: SubscriberCounts = {
    pending: 0,
    subscribed: 0,
    unsubscribed: 0,
    bounced: 0,
    complained: 0,
    total: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.value;
    counts.total += row.value;
  }
  return counts;
}

/** Everyone a campaign may actually be sent to. */
export async function listConfirmedRecipients(
  db: BlogDatabase,
): Promise<{ id: string; email: string; name: string | null }[]> {
  return db
    .select({ id: subscribers.id, email: subscribers.email, name: subscribers.name })
    .from(subscribers)
    .where(eq(subscribers.status, "subscribed"))
    .orderBy(subscribers.createdAt);
}

/* --- per-subscriber metrics --------------------------------------------- */

export type SubscriberMetrics = {
  /** Emails that left the building. The denominator for open rate. */
  delivered: number;
  failed: number;
  opened: number;
  clicked: number;
  total_opens: number;
  total_clicks: number;
  /** opened / delivered. Null when nothing has been delivered yet. */
  open_rate: number | null;
  /**
   * Click-to-open: clicked / opened.
   *
   * Deliberately over opens rather than over deliveries. Click-through-rate
   * mixes two different failures — a subject line nobody opened, and a piece
   * nobody wanted to read further — and CTOR isolates the second, which is
   * the one that is about the writing.
   */
  ctor: number | null;
};

export async function getSubscriberMetrics(
  db: BlogDatabase,
  subscriberId: string,
): Promise<SubscriberMetrics> {
  const [row] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${emailSends.status} = 'sent')::int`,
      failed: sql<number>`count(*) filter (where ${emailSends.status} = 'failed')::int`,
      opened: sql<number>`count(*) filter (where ${emailSends.openedAt} is not null)::int`,
      clicked: sql<number>`count(*) filter (where ${emailSends.clickedAt} is not null)::int`,
      totalOpens: sql<number>`coalesce(sum(${emailSends.openCount}), 0)::int`,
      totalClicks: sql<number>`coalesce(sum(${emailSends.clickCount}), 0)::int`,
    })
    .from(emailSends)
    .where(eq(emailSends.subscriberId, subscriberId));

  return toMetrics(row);
}

export function toMetrics(row: {
  delivered: number;
  failed: number;
  opened: number;
  clicked: number;
  totalOpens: number;
  totalClicks: number;
} | undefined): SubscriberMetrics {
  const delivered = row?.delivered ?? 0;
  const opened = row?.opened ?? 0;
  const clicked = row?.clicked ?? 0;
  return {
    delivered,
    failed: row?.failed ?? 0,
    opened,
    clicked,
    total_opens: row?.totalOpens ?? 0,
    total_clicks: row?.totalClicks ?? 0,
    open_rate: delivered > 0 ? opened / delivered : null,
    ctor: opened > 0 ? clicked / opened : null,
  };
}

export type TimelineEntry = {
  id: string;
  type: SubscriberEventType;
  url: string | null;
  created_at: string;
  campaign: { id: string; subject: string } | null;
};

/** The chronological feed shown on a subscriber's profile. */
export async function getSubscriberTimeline(
  db: BlogDatabase,
  subscriberId: string,
  limit = 50,
): Promise<TimelineEntry[]> {
  const rows = await db
    .select({
      id: subscriberEvents.id,
      type: subscriberEvents.type,
      url: subscriberEvents.url,
      createdAt: subscriberEvents.createdAt,
      campaignId: sql<string | null>`campaigns.id`,
      subject: sql<string | null>`campaigns.subject`,
    })
    .from(subscriberEvents)
    .leftJoin(emailSends, eq(subscriberEvents.sendId, emailSends.id))
    .leftJoin(
      sql`email_campaigns as campaigns`,
      sql`campaigns.id = ${emailSends.campaignId}`,
    )
    .where(eq(subscriberEvents.subscriberId, subscriberId))
    .orderBy(desc(subscriberEvents.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    url: row.url,
    created_at: iso(row.createdAt) ?? "",
    campaign:
      row.campaignId && row.subject
        ? { id: row.campaignId, subject: row.subject }
        : null,
  }));
}

/* --- audience-wide series ----------------------------------------------- */

export type GrowthPoint = {
  date: string;
  /** Signups that day, whether or not they went on to confirm. */
  joined: number;
  /** Unsubscribes that day. */
  left: number;
  net: number;
};

/**
 * Daily acquisition against churn, for the trailing `days` days.
 *
 * The date spine is generated in SQL rather than filled in afterwards, so a
 * day with no activity is a zero in the series instead of a missing point the
 * chart would silently close up. A flat line and a gap look identical once
 * they are drawn, and they mean very different things.
 */
export async function getGrowthSeries(
  db: BlogDatabase,
  days = 30,
): Promise<GrowthPoint[]> {
  const rows = await db.execute<{ day: string; joined: number; left: number }>(sql`
    with spine as (
      select generate_series(
        (current_date - (${days - 1}::int)),
        current_date,
        interval '1 day'
      )::date as day
    ),
    joins as (
      select created_at::date as day, count(*)::int as n
      from subscribers
      where created_at >= current_date - (${days - 1}::int)
      group by 1
    ),
    leaves as (
      select unsubscribed_at::date as day, count(*)::int as n
      from subscribers
      where unsubscribed_at is not null
        and unsubscribed_at >= current_date - (${days - 1}::int)
      group by 1
    )
    select
      to_char(spine.day, 'YYYY-MM-DD') as day,
      coalesce(joins.n, 0) as joined,
      coalesce(leaves.n, 0) as "left"
    from spine
    left join joins on joins.day = spine.day
    left join leaves on leaves.day = spine.day
    order by spine.day
  `);

  return rowsOf<{ day: string; joined: number; left: number }>(rows).map((row) => ({
    date: String(row.day),
    joined: Number(row.joined),
    left: Number(row.left),
    net: Number(row.joined) - Number(row.left),
  }));
}

export type AcquisitionSource = {
  /** utm_source when present, else the referring host, else "direct". */
  label: string;
  medium: string | null;
  campaign: string | null;
  count: number;
  /** How many of them went on to confirm. */
  confirmed: number;
};

/**
 * Which channels actually produced subscribers.
 *
 * Grouped on the coalesced label rather than on utm_source alone: most real
 * traffic arrives with no UTM at all, and a report that showed only tagged
 * campaigns would make the tagged ones look like the whole picture.
 */
export async function getAcquisitionSources(
  db: BlogDatabase,
  limit = 12,
): Promise<AcquisitionSource[]> {
  const label = sql<string>`coalesce(nullif(${subscribers.utmSource}, ''), ${subscribers.referrerHost}, 'direct')`;

  const rows = await db
    .select({
      label,
      medium: subscribers.utmMedium,
      campaign: subscribers.utmCampaign,
      count: sql<number>`count(*)::int`,
      confirmed: sql<number>`count(*) filter (where ${subscribers.status} = 'subscribed')::int`,
    })
    .from(subscribers)
    .groupBy(label, subscribers.utmMedium, subscribers.utmCampaign)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return rows.map((row) => ({
    label: row.label,
    medium: row.medium,
    campaign: row.campaign,
    count: row.count,
    confirmed: row.confirmed,
  }));
}

/** Recently landed signups, for the dashboard strip. */
export async function countRecentSubscribers(
  db: BlogDatabase,
  days = 30,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(subscribers)
    .where(sql`${subscribers.createdAt} >= now() - make_interval(days => ${days})`);
  return row?.value ?? 0;
}

export async function countChurnedSubscribers(
  db: BlogDatabase,
  days = 30,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(subscribers)
    .where(
      and(
        isNotNull(subscribers.unsubscribedAt),
        sql`${subscribers.unsubscribedAt} >= now() - make_interval(days => ${days})`,
      ),
    );
  return row?.value ?? 0;
}

/**
 * `db.execute` returns the driver's own result shape — an array under
 * node-postgres, `{ rows }` under Neon HTTP. One helper rather than a cast at
 * every call site.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 500);
}
