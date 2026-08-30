import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/**
 * Post lifecycle. Kept as a plain text column (per spec) rather than a pg enum
 * so adding a state later is a data change, not a type migration.
 */
export const POST_STATUSES = ["draft", "published"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

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

export const schema = { posts, tags, postTags, media };

export type PostRow = typeof posts.$inferSelect;
export type NewPostRow = typeof posts.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
