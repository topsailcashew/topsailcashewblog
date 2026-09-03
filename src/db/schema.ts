import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/** Postgres full-text search vector. Drizzle has no first-class type for it. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

/**
 * Post lifecycle. Kept as a plain text column (per spec) rather than a pg enum
 * so adding a state later is a data change, not a type migration.
 */
export const POST_STATUSES = ["draft", "published"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const series = pgTable("series", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    /** Tiptap document — source of truth. Populated by the Phase 2 editor. */
    contentJson: jsonb("content_json"),
    /** Rendered from content_json on publish; used for fast reads and RSS. */
    contentHtml: text("content_html"),
    excerpt: text("excerpt"),
    coverImageUrl: text("cover_image_url"),
    status: text("status").notNull().default("draft").$type<PostStatus>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Nullable: most posts stand alone. Order within a series is published_at. */
    seriesId: uuid("series_id").references(() => series.id, {
      onDelete: "set null",
    }),

    /*
      Per-post SEO overrides. All nullable, and all fall back to what the page
      already derives — meta_title to the title, meta_description to the
      excerpt, og_image_url to the cover then the generated card. Kept as
      overrides rather than required fields so nothing has to be filled in for
      a post to be correct.
    */
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    /** Absolute URL, for a post that is a republication of something else. */
    canonicalUrl: text("canonical_url"),
    /** Keeps a live post out of search results without unpublishing it. */
    noindex: boolean("noindex").notNull().default(false),

    /**
     * Leads the home page.
     *
     * Not constrained to one row. A uniqueness rule would mean featuring a
     * post is two writes that can half-fail; instead the newest featured post
     * wins, so setting a new one is a single write and the old one simply
     * stops being the most recent.
     */
    featured: boolean("featured").notNull().default(false),
    ogImageUrl: text("og_image_url"),

    /**
     * Trash, not deletion.
     *
     * Set instead of removing the row, and filtered out of every query. The
     * admin can restore until the trash is emptied, at which point the row is
     * deleted for real.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    /**
     * When this post was broadcast to the fediverse.
     *
     * Set once. Federation has no edit semantics worth relying on — an Update
     * activity is honoured by some instances and ignored by others — so a
     * republish must not re-announce a post that followers already have in
     * their timeline.
     */
    federatedAt: timestamp("federated_at", { withTimezone: true }),

    /*
      Provenance for posts that arrived from an import rather than the editor.

      `import_key` is the file's path within the folder that was dropped, e.g.
      "essays/2026/slow-software.md". Unique, so dropping the same folder again
      updates the drafts it made last time instead of producing a second copy
      of everything — which is the behaviour you want when you have edited a
      file locally and want the change reflected here.
    */
    importKey: text("import_key").unique(),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    /**
     * Maintained by Postgres, so it can never drift from the row.
     * Weighted A/B/C so a title match outranks a body match; the body is the
     * rendered HTML with tags stripped, which is close enough to plain text
     * for ranking and avoids storing a second copy of every post.
     */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
          setweight(to_tsvector('english', regexp_replace(coalesce(content_html, ''), '<[^>]*>', ' ', 'g')), 'C')`,
    ),
  },
  (table) => [
    // Drives the default list query: published posts, newest first.
    index("posts_status_published_at_idx").on(
      table.status,
      table.publishedAt.desc(),
    ),
    index("posts_created_at_idx").on(table.createdAt.desc()),
    // Defense in depth: the API validates status too, but this keeps a bad
    // write out of the table no matter which client makes it.
    check("posts_status_check", sql`${table.status} in ('draft', 'published')`),
    index("posts_series_idx").on(table.seriesId),
    index("posts_search_idx").using("gin", table.searchVector),
    // Drives the trash view and, more importantly, keeps the "not trashed"
    // predicate on every other query cheap.
    index("posts_deleted_at_idx").on(table.deletedAt),
  ],
);

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
});

export const postTags = pgTable(
  "post_tags",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.tagId] }),
    index("post_tags_tag_id_idx").on(table.tagId),
  ],
);

/**
 * How an image functions on the page, which is what its alt text has to
 * follow. WCAG's decision tree, as four values.
 */
export const MEDIA_ROLES = [
  "informative",
  "decorative",
  "functional",
  "complex",
] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

/**
 * Media rows are written by the R2 upload flow. `r2Key` is the object key
 * inside the bucket; `url` is the public (or signed) URL we serve.
 *
 * Deliberately not joined to posts. An image can be referenced from a cover,
 * from inline HTML, or from a page, and a join table would have to be kept in
 * step with the editor on every keystroke. The library answers "where is this
 * used?" by searching for the URL instead — see `findMediaUsage`, which is a
 * scan the size of this blog can afford and a foreign key cannot go stale.
 */
export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    r2Key: text("r2_key").notNull(),
    url: text("url").notNull(),
    altText: text("alt_text"),
    /** Original upload name, so the library is searchable by what you called it. */
    filename: text("filename"),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),

    /**
     * What the image is *for*, which is what decides its alt text.
     *
     * Alt text is not a description field, it is a function of the image's
     * role, and the roles have genuinely different rules:
     *   informative — describe the content
     *   decorative  — emit alt="" so a screen reader skips it entirely
     *   functional  — describe the *action*, not the picture (a link or button)
     *   complex     — a short alt plus a long description elsewhere on the page
     *
     * Storing the role rather than only the text is what lets the renderer get
     * `alt=""` right. An empty alt and a missing alt look identical in a
     * database column and mean opposite things to a screen reader.
     */
    role: text("role").notNull().default("informative").$type<MediaRole>(),
    /** The prose for a `complex` image — a chart's actual numbers, say. */
    longDescription: text("long_description"),

    /*
      Intrinsic metadata, extracted at upload. Dimensions come from the file
      header on the server; the placeholder needs a real pixel decode and is
      produced in the browser. See src/lib/image-metadata.ts.
    */
    width: integer("width"),
    height: integer("height"),
    /** A ~30-byte BlurHash, or null when the browser could not decode. */
    blurhash: text("blurhash"),
    /** Tiny base64 WebP/JPEG data URI, inlined as a background while loading. */
    lqip: text("lqip"),
    /** Camera, lens, capture time, orientation. GPS is stripped — see extractExif. */
    exif: jsonb("exif"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("media_created_at_idx").on(table.createdAt.desc()),
    check(
      "media_role_check",
      sql`${table.role} in ('informative', 'decorative', 'functional', 'complex')`,
    ),
  ],
);

/**
 * Permanent redirects from a URL this site used to serve.
 *
 * Written automatically when a post or page slug changes, and editable by
 * hand. Without this a rename silently 404s every inbound link, share and
 * search result that pointed at the old address — the rename itself is one
 * line, and this is the other half of it.
 */
export const redirects = pgTable(
  "redirects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Site-relative, leading slash, no query: "/old-post". */
    fromPath: text("from_path").notNull().unique(),
    /** Site-relative or absolute. */
    toPath: text("to_path").notNull(),
    /** True when a slug change created this rather than a person. */
    automatic: boolean("automatic").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("redirects_from_idx").on(table.fromPath)],
);

/**
 * Point-in-time snapshots of a post, for recovery.
 *
 * Deliberately *not* written on every autosave — that is what makes WordPress
 * revision tables enormous. See `src/lib/revisions.ts` for the rules: one
 * snapshot per publish transition, at most one per hour while drafting, and
 * only the last MAX_REVISIONS_PER_POST are kept.
 *
 * `content_html` is not stored: it is derived from `content_json`, so keeping
 * it would roughly double the table for nothing.
 */
export const postRevisions = pgTable(
  "post_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    contentJson: jsonb("content_json"),
    /** Why the snapshot was taken, shown in the restore list. */
    reason: text("reason").notNull().default("edit"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("post_revisions_post_created_idx").on(table.postId, table.createdAt.desc())],
);

/**
 * Standalone pages — About, Contact and so on.
 *
 * A separate table rather than a `type` column on `posts`: pages carry no
 * tags, series, comments or publication date, and adding a discriminator to
 * posts would mean auditing every public query for a filter it could silently
 * miss.
 */
export const pages = pgTable("pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  contentJson: jsonb("content_json"),
  contentHtml: text("content_html"),
  /** The About page uses this as its portrait; other pages may have none. */
  coverImageUrl: text("cover_image_url"),
  status: text("status").notNull().default("draft").$type<PostStatus>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Where a comment came in from. */
export const COMMENT_SOURCES = ["web", "fediverse"] as const;
export type CommentSource = (typeof COMMENT_SOURCES)[number];

export const COMMENT_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "spam",
] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/**
 * Reader comments. The only public write surface in the app.
 *
 * Everything arrives as `pending` and stays invisible until approved.
 * Rejected and spam rows are kept rather than deleted so the moderation
 * history survives.
 */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    /** One level only: a reply to a reply is re-parented to the top-level one. */
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, {
      onDelete: "cascade",
    }),
    authorName: text("author_name").notNull(),
    /**
     * Collected for moderation contact. Never rendered on a public page.
     *
     * Nullable only because a federated reply has no email to collect — the
     * check constraint below still requires one for every web submission.
     */
    authorEmail: text("author_email"),
    /** "web" for the on-page form, "fediverse" for a federated reply. */
    source: text("source").notNull().default("web").$type<CommentSource>(),
    /** The remote account that wrote it, e.g. https://example.social/users/bob. */
    remoteActorUri: text("remote_actor_uri"),
    /** The remote object's id. Unique, so a redelivered activity is not a second comment. */
    remoteObjectUri: text("remote_object_uri").unique(),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending").$type<CommentStatus>(),
    /** True for replies written from the admin queue, badged as the author. */
    isAuthor: boolean("is_author").notNull().default(false),
    /** HMAC of the submitter's IP — rate limiting only, never the raw address. */
    authorIpHash: text("author_ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Drives the public thread query: approved comments for one post.
    index("comments_post_status_idx").on(table.postId, table.status),
    index("comments_parent_idx").on(table.parentId),
    // Drives the moderation queue.
    index("comments_status_created_idx").on(table.status, table.createdAt.desc()),
    // Drives the rate-limit lookup.
    index("comments_ip_created_idx").on(table.authorIpHash, table.createdAt),
    check(
      "comments_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'spam')`,
    ),
    check(
      "comments_source_check",
      sql`${table.source} in ('web', 'fediverse')`,
    ),
    // A web comment must carry an email; a federated one must carry an actor.
    // Without this, dropping NOT NULL above would silently permit an anonymous
    // web submission with no way to reply to it.
    check(
      "comments_identity_check",
      sql`(${table.source} = 'web' and ${table.authorEmail} is not null)
          or (${table.source} = 'fediverse' and ${table.remoteActorUri} is not null)`,
    ),
  ],
);

/* ------------------------------------------------------------------------ *
 * Audience
 * ------------------------------------------------------------------------ */

/**
 * Where a subscriber is in their lifecycle.
 *
 * `pending` is the state a signup lands in before the confirmation link is
 * clicked. Nothing is ever emailed to a pending address except that one
 * confirmation — double opt-in is not a nicety here, it is what keeps a
 * self-hosted sending domain out of the spam folder.
 */
export const SUBSCRIBER_STATUSES = [
  "pending",
  "subscribed",
  "unsubscribed",
  "bounced",
  "complained",
] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored lowercased and trimmed; the unique index is what dedupes signups. */
    email: text("email").notNull().unique(),
    name: text("name"),
    status: text("status").notNull().default("pending").$type<SubscriberStatus>(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),

    /*
      Acquisition attribution, captured once at signup and never updated.

      A subscriber's *first* touch is the interesting one — which post, which
      campaign, which referrer actually earned the address. Overwriting it on a
      later visit would turn every channel report into a report about whichever
      page they happened to be on most recently.
    */
    source: text("source").notNull().default("form"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    /** Origin only — the full referring URL can carry a query string with PII. */
    referrerHost: text("referrer_host"),
    /** The path they subscribed from, which is usually the post that convinced them. */
    landingPath: text("landing_path"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Drives the audience list and the "who gets this send" query.
    index("subscribers_status_created_idx").on(table.status, table.createdAt.desc()),
    // Drives the 30-day acquisition series.
    index("subscribers_created_at_idx").on(table.createdAt.desc()),
    // Drives the churn half of the same chart.
    index("subscribers_unsubscribed_at_idx").on(table.unsubscribedAt.desc()),
    check(
      "subscribers_status_check",
      sql`${table.status} in ('pending', 'subscribed', 'unsubscribed', 'bounced', 'complained')`,
    ),
  ],
);

export const CAMPAIGN_STATUSES = ["draft", "sending", "sent", "failed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * One send to the list.
 *
 * Usually a post going out, in which case `post_id` is set and the body is
 * rendered from that post. `post_id` is nullable so a plain broadcast (a note
 * to readers that is not itself an article) is the same object.
 *
 * Rates are *not* stored here. Opens and clicks are counted off `email_sends`,
 * which is the row the tracking pixel already has to touch — a denormalised
 * counter would be a second write that can fail on its own, and every number
 * on the analytics screen would then be a number nobody could reproduce.
 */
export const emailCampaigns = pgTable(
  "email_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "set null" }),
    subject: text("subject").notNull(),
    /** Snapshot of what went out. A later edit to the post must not rewrite history. */
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    status: text("status").notNull().default("draft").$type<CampaignStatus>(),
    /** How many rows we set out to write; `email_sends` is the record of what happened. */
    recipientCount: integer("recipient_count").notNull().default(0),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("email_campaigns_created_idx").on(table.createdAt.desc()),
    index("email_campaigns_post_idx").on(table.postId),
    check(
      "email_campaigns_status_check",
      sql`${table.status} in ('draft', 'sending', 'sent', 'failed')`,
    ),
  ],
);

export const SEND_STATUSES = ["queued", "sent", "failed"] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];

/**
 * One campaign, one subscriber.
 *
 * This is the row the open pixel and the click redirect resolve to, and the
 * row every rate on the analytics screens is computed from:
 *
 *   open rate = opened_at is not null / status = 'sent'
 *   CTOR      = clicked_at is not null / opened_at is not null
 *
 * `opened_at` is the *first* open and `open_count` the total, because a
 * forwarded email or a mail client that re-fetches images would otherwise
 * make one reader look like several.
 */
export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => emailCampaigns.id, { onDelete: "cascade" }),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued").$type<SendStatus>(),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    openCount: integer("open_count").notNull().default(0),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    clickCount: integer("click_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per pair, so a retried send updates rather than duplicates —
    // and so a subscriber can never be mailed the same campaign twice.
    unique("email_sends_campaign_subscriber_key").on(
      table.campaignId,
      table.subscriberId,
    ),
    // Drives every per-campaign rate.
    index("email_sends_campaign_idx").on(table.campaignId),
    // Drives the per-subscriber lifetime rates on the profile screen.
    index("email_sends_subscriber_idx").on(table.subscriberId),
    check(
      "email_sends_status_check",
      sql`${table.status} in ('queued', 'sent', 'failed')`,
    ),
  ],
);

export const SUBSCRIBER_EVENT_TYPES = [
  "subscribed",
  "confirmed",
  "unsubscribed",
  "sent",
  "opened",
  "clicked",
  "bounced",
  "complained",
] as const;
export type SubscriberEventType = (typeof SUBSCRIBER_EVENT_TYPES)[number];

/**
 * The chronological feed on a subscriber's profile.
 *
 * Overlaps with `email_sends` on purpose. That table holds the *current state*
 * of a send and answers "what is the open rate"; this one is append-only and
 * answers "what happened, in order" — including the second open and the third
 * click, which the state row deliberately collapses.
 */
export const subscriberEvents = pgTable(
  "subscriber_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    /** Null for lifecycle events (subscribed, unsubscribed) that belong to no send. */
    sendId: uuid("send_id").references(() => emailSends.id, { onDelete: "cascade" }),
    type: text("type").notNull().$type<SubscriberEventType>(),
    /** The destination, for a click. */
    url: text("url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("subscriber_events_subscriber_idx").on(
      table.subscriberId,
      table.createdAt.desc(),
    ),
    check(
      "subscriber_events_type_check",
      sql`${table.type} in ('subscribed', 'confirmed', 'unsubscribed', 'sent', 'opened', 'clicked', 'bounced', 'complained')`,
    ),
  ],
);

/**
 * Runtime configuration that belongs to the person, not the deployment.
 *
 * SMTP hostnames and newsletter copy change with the mood; they should not
 * need a redeploy. Values are JSON so one row can hold a whole settings group.
 *
 * Anything secret in here is encrypted before it lands (see src/lib/settings.ts)
 * — a database backup is a much more casual artefact than a Worker secret.
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/* ------------------------------------------------------------------------ *
 * Federation (ActivityPub)
 * ------------------------------------------------------------------------ */

/**
 * A remote account following this blog's actor.
 *
 * `shared_inbox_uri` is what makes delivery affordable: a thousand followers
 * on one Mastodon instance are one POST to that instance's shared inbox, not a
 * thousand POSTs. Delivery groups by `coalesce(shared_inbox_uri, inbox_uri)`.
 */
export const apFollowers = pgTable(
  "ap_followers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The follower's canonical id, e.g. https://mastodon.social/users/alice. */
    actorUri: text("actor_uri").notNull().unique(),
    inboxUri: text("inbox_uri").notNull(),
    sharedInboxUri: text("shared_inbox_uri"),
    /** Cached for display, never trusted for identity. */
    handle: text("handle"),
    /** Unfollows keep the row so the history survives; delivery filters on this. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ap_followers_active_idx").on(table.active)],
);

/**
 * One outbound federated delivery attempt.
 *
 * Federation fails constantly and silently — instances go down, block you, or
 * change their key. Without a log the only symptom is "nobody saw the post",
 * which is indistinguishable from "nobody cared".
 */
export const apDeliveries = pgTable(
  "ap_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    inboxUri: text("inbox_uri").notNull(),
    /** HTTP status from the remote inbox, or null if the request never completed. */
    statusCode: integer("status_code"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ap_deliveries_post_idx").on(table.postId, table.createdAt.desc())],
);

export const postsRelations = relations(posts, ({ many }) => ({
  postTags: many(postTags),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  postTags: many(postTags),
}));

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}));

export const schema = {
  posts,
  tags,
  postTags,
  media,
  series,
  comments,
  postRevisions,
  pages,
  redirects,
  subscribers,
  emailCampaigns,
  emailSends,
  subscriberEvents,
  settings,
  apFollowers,
  apDeliveries,
};

export type RedirectRow = typeof redirects.$inferSelect;
export type SeriesRow = typeof series.$inferSelect;
export type PageRow = typeof pages.$inferSelect;
export type PostRevisionRow = typeof postRevisions.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type PostRow = typeof posts.$inferSelect;
export type NewPostRow = typeof posts.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type SubscriberRow = typeof subscribers.$inferSelect;
export type EmailCampaignRow = typeof emailCampaigns.$inferSelect;
export type EmailSendRow = typeof emailSends.$inferSelect;
export type SubscriberEventRow = typeof subscriberEvents.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type ApFollowerRow = typeof apFollowers.$inferSelect;
