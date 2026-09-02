import { z } from "zod";
import { COMMENT_STATUSES, POST_STATUSES } from "@/db/schema";
import { isValidSlug, RESERVED_SLUGS } from "./slug";

/**
 * Wire format is snake_case to match the field names in the project spec
 * (`content_json`, `cover_image_url`, ...). Drizzle's camelCase row shape is an
 * internal detail; `serializePost` maps back on the way out.
 */

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(isValidSlug, "Slug must be lowercase words separated by single hyphens")
  .refine(
    (value) => !RESERVED_SLUGS.has(value),
    "That slug is used by a built-in route",
  );

const titleSchema = z.string().trim().min(1, "Title is required").max(500);
const nullableText = z.string().nullable().optional();
/**
 * An absolute http(s) URL, or a site-relative path such as the `/media/<key>`
 * that an R2 upload returns when no public CDN base URL is configured.
 * Protocol-relative `//host` is rejected — it would point off-site.
 */
const mediaUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) =>
      /^https?:\/\//.test(value) ||
      (value.startsWith("/") && !value.startsWith("//")),
    "Must be an absolute http(s) URL or a site-relative path",
  );

const nullableUrl = z
  .union([mediaUrlSchema, z.literal(""), z.null()])
  .optional();

/** Tiptap document. Not validated structurally until the Phase 2 editor lands. */
const contentJsonSchema = z.unknown().nullable().optional();

const tagsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(25, "A post can carry at most 25 tags")
  .optional();

export const createPostSchema = z.object({
  title: titleSchema,
  /** Optional on create — omitted means "derive it from the title". */
  slug: slugSchema.optional(),
  content_json: contentJsonSchema,
  content_html: nullableText,
  excerpt: nullableText,
  cover_image_url: nullableUrl,
  status: z.enum(POST_STATUSES).optional(),
  tags: tagsSchema,
  series_id: z.uuid().nullable().optional(),
  published_at: z.iso.datetime().nullable().optional(),
  /* Per-post SEO overrides. Each falls back to a derived value when null. */
  meta_title: z.string().trim().max(200).nullable().optional(),
  meta_description: z.string().trim().max(400).nullable().optional(),
  canonical_url: z.union([z.url().max(2048), z.literal(""), z.null()]).optional(),
  noindex: z.boolean().optional(),
  og_image_url: nullableUrl,
  /** Leads the home page. */
  featured: z.boolean().optional(),
});

export const updatePostSchema = z
  .object({
    title: titleSchema.optional(),
    slug: slugSchema.optional(),
    content_json: contentJsonSchema,
    content_html: nullableText,
    excerpt: nullableText,
    cover_image_url: nullableUrl,
    status: z.enum(POST_STATUSES).optional(),
    tags: tagsSchema,
    series_id: z.uuid().nullable().optional(),
    /* A future value schedules the post; the public queries hide it until
       the moment passes. */
    published_at: z.iso.datetime().nullable().optional(),
    /* Per-post SEO overrides. Each falls back to a derived value when null. */
    meta_title: z.string().trim().max(200).nullable().optional(),
    meta_description: z.string().trim().max(400).nullable().optional(),
    canonical_url: z.union([z.url().max(2048), z.literal(""), z.null()]).optional(),
    noindex: z.boolean().optional(),
    og_image_url: nullableUrl,
    /** Leads the home page. */
    featured: z.boolean().optional(),
  })
  .refine(
    (body) => Object.keys(body).length > 0,
    "Provide at least one field to update",
  );

/*
  What the admin list can be filtered by. Deliberately *not* added to
  POST_STATUSES: trash is orthogonal to draft/published — a trashed post keeps
  the status it had — and widening the status enum would loosen the check
  constraint on the column for the sake of a query parameter.
*/
export const POST_LIST_FILTERS = [...POST_STATUSES, "trash"] as const;
export type PostListFilter = (typeof POST_LIST_FILTERS)[number];

export const listPostsQuerySchema = z.object({
  status: z.enum(POST_LIST_FILTERS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const uuidSchema = z.uuid("Expected a post id (uuid)");

/* --- series ------------------------------------------------------------- */

export const createSeriesSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  slug: slugSchema.optional(),
});

export const updateSeriesSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    slug: slugSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Provide a field to update");

/* --- pages -------------------------------------------------------------- */

export const createPageSchema = z.object({
  title: titleSchema,
  slug: slugSchema.optional(),
  content_json: contentJsonSchema,
  content_html: nullableText,
  status: z.enum(POST_STATUSES).optional(),
});

export const updatePageSchema = z
  .object({
    title: titleSchema.optional(),
    slug: slugSchema.optional(),
    content_json: contentJsonSchema,
    content_html: nullableText,
    status: z.enum(POST_STATUSES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Provide a field to update");

/* --- comments ----------------------------------------------------------- */

/**
 * The honeypot is a field a human never sees and never fills. Anything in it
 * marks the submission as automated.
 */
export const HONEYPOT_FIELD = "website";

export const submitCommentSchema = z.object({
  post_id: z.uuid("Unknown post"),
  parent_id: z.uuid().nullable().optional(),
  author_name: z.string().trim().min(1, "Please add your name").max(120),
  author_email: z.email("That does not look like an email address").max(320),
  body: z
    .string()
    .trim()
    .min(2, "Please write a little more")
    .max(4000, "Comments are capped at 4000 characters"),
  /*
    Accepted as any string on purpose. Rejecting a filled honeypot here would
    return a 422 naming the field, telling an automated client exactly what
    caught it; the route accepts the submission normally and discards it.
  */
  [HONEYPOT_FIELD]: z.string().max(200).optional(),
});

export const moderateCommentSchema = z.object({
  status: z.enum(COMMENT_STATUSES),
});

export const authorReplySchema = z.object({
  body: z.string().trim().min(1, "Write a reply").max(4000),
});

export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

/** Parses `?status=&limit=&offset=`, dropping empty values so defaults apply. */
export function parseListQuery(url: URL): ListPostsQuery {
  const raw: Record<string, string> = {};
  for (const key of ["status", "limit", "offset"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") raw[key] = value;
  }
  return listPostsQuerySchema.parse(raw);
}
