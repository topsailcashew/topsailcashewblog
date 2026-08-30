import { z } from "zod";
import { POST_STATUSES } from "@/db/schema";
import { isValidSlug } from "./slug";

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
  .refine(isValidSlug, "Slug must be lowercase words separated by single hyphens");

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
  })
  .refine(
    (body) => Object.keys(body).length > 0,
    "Provide at least one field to update",
  );

export const listPostsQuerySchema = z.object({
  status: z.enum(POST_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const uuidSchema = z.uuid("Expected a post id (uuid)");

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
