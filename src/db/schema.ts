import {
  boolean,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
 * Media rows are written by the Phase 2 R2 upload flow. `r2Key` is the object
 * key inside the bucket; `url` is the public (or signed) URL we serve.
 * Deliberately not joined to posts yet — inline images live in content_json.
 */
export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  r2Key: text("r2_key").notNull(),
  url: text("url").notNull(),
  altText: text("alt_text"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
  status: text("status").notNull().default("draft").$type<PostStatus>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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
    /** Collected for moderation contact. Never rendered on a public page. */
    authorEmail: text("author_email").notNull(),
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
  ],
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
};

export type SeriesRow = typeof series.$inferSelect;
export type PageRow = typeof pages.$inferSelect;
export type PostRevisionRow = typeof postRevisions.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type PostRow = typeof posts.$inferSelect;
export type NewPostRow = typeof posts.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
