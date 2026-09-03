import { z } from "zod";
import {
  COMMENT_STATUSES,
  MEDIA_ROLES,
  POST_STATUSES,
  SUBSCRIBER_STATUSES,
} from "@/db/schema";
import { SMTP_SECURITY } from "./email/config";
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
  cover_image_url: nullableUrl,
  status: z.enum(POST_STATUSES).optional(),
});

export const updatePageSchema = z
  .object({
    title: titleSchema.optional(),
    slug: slugSchema.optional(),
    content_json: contentJsonSchema,
    content_html: nullableText,
    cover_image_url: nullableUrl,
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

/* --- audience ------------------------------------------------------------ */

/**
 * A public signup.
 *
 * Attribution fields are accepted from the client because that is the only
 * place they exist — UTM parameters live in the URL the browser is looking at,
 * and `document.referrer` is not sent as a header on a same-origin fetch. They
 * are therefore untrusted: capped in length, stored as plain text, and never
 * interpolated anywhere they could be executed. The worst a forged value can
 * do is put a wrong label in one row of a report.
 */
const attribution = z.string().trim().max(200).nullable().optional();

export const subscribeSchema = z.object({
  email: z.email("That does not look like an email address").max(320),
  name: z.string().trim().max(120).nullable().optional(),
  utm_source: attribution,
  utm_medium: attribution,
  utm_campaign: attribution,
  utm_term: attribution,
  utm_content: attribution,
  referrer: z.string().trim().max(500).nullable().optional(),
  landing_path: z.string().trim().max(500).nullable().optional(),
  /* Same honeypot rule as comments: accepted, then silently discarded. */
  [HONEYPOT_FIELD]: z.string().max(200).optional(),
});

export const listSubscribersQuerySchema = z.object({
  status: z.enum(SUBSCRIBER_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* --- settings ------------------------------------------------------------ */

export const smtpSettingsSchema = z.object({
  host: z.string().trim().max(255),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(SMTP_SECURITY),
  username: z.string().trim().max(255),
  /**
   * Absent means "leave the stored one alone"; null means "clear it".
   * An empty string is treated as absent, because that is what an untouched
   * password field posts.
   */
  password: z.string().max(500).nullable().optional(),
  from_name: z.string().trim().max(120),
  from_email: z.union([z.email().max(320), z.literal("")]),
  reply_to: z.union([z.email().max(320), z.literal(""), z.null()]).optional(),
});

export const newsletterSettingsSchema = z.object({
  enabled: z.boolean(),
  pitch: z.string().trim().max(400),
  footer: z.string().trim().max(600),
  double_opt_in: z.boolean(),
});

export const sendTestSchema = z.object({
  to: z.email("Where should the test go?").max(320),
});

/**
 * What a publish does about email.
 *
 * "email" without "publish" is a send to the list that never appears on the
 * site — which is why the email body drops its "read it on the site" link in
 * that case; there would be nothing at the other end of it.
 */
export const PUBLISH_MODES = ["publish", "publish_and_email", "email"] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

export const sendNewsletterSchema = z.object({
  mode: z.enum(PUBLISH_MODES).default("publish_and_email"),
  /** Recipients per call. The client loops until nothing remains. */
  batch_size: z.coerce.number().int().min(1).max(100).optional(),
});

/* --- media --------------------------------------------------------------- */

export const updateMediaSchema = z
  .object({
    alt_text: z.string().max(500).nullable().optional(),
    role: z.enum(MEDIA_ROLES).optional(),
    long_description: z.string().max(4000).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Provide a field to update");

/**
 * Image metadata measured in the browser at upload time.
 *
 * Untrusted, like everything else from a client, and bounded accordingly: the
 * placeholder is capped so it cannot be used to smuggle a large payload into
 * a column that gets inlined into every page that renders the image.
 */
export const imageMetadataSchema = z.object({
  width: z.coerce.number().int().min(1).max(100000).optional(),
  height: z.coerce.number().int().min(1).max(100000).optional(),
  blurhash: z.string().max(200).optional(),
  lqip: z
    .string()
    .max(4000)
    .refine((value) => value.startsWith("data:image/"), "LQIP must be an image data URI")
    .optional(),
});

/* --- federation ---------------------------------------------------------- */

export const fediverseSettingsSchema = z.object({
  enabled: z.boolean(),
  /**
   * The local part of the handle. Constrained to what the fediverse actually
   * accepts in an `acct:` — letters, digits, underscore and hyphen — because
   * anything else produces a handle no client can resolve.
   */
  username: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_-]+$/, "Letters, digits, underscore and hyphen only"),
  summary: z.string().trim().max(500),
});

/* --- writing assistance --------------------------------------------------- */

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  /**
   * Absent means "leave the stored one alone"; null means "clear it".
   * An empty string is treated as absent, because that is what an untouched
   * password field posts.
   */
  api_key: z.string().max(300).nullable().optional(),
  text_model: z.string().trim().min(1).max(80),
  image_model: z.string().trim().min(1).max(80),
});

/**
 * The cover route accepts an optional brief.
 *
 * Passing one back skips stage one and re-runs only the image, which is
 * cheaper and faster — and it is what turns "try again" from a slot machine
 * into a steering wheel.
 */
export const generateCoverSchema = z
  .object({
    brief: z
      .object({
        subject: z.string().trim().min(8).max(300),
        human: z.string().trim().max(120).optional(),
        avoid: z.array(z.string().trim().max(60)).max(4).optional(),
      })
      .optional(),
  })
  .optional()
  .default({});
