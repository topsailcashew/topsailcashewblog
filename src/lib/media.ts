import { count, desc, eq, ilike, or } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { media, pages, posts, type MediaRow } from "@/db/schema";
import { ApiError, notFound } from "./http";
import { MAX_UPLOAD_BYTES } from "./upload-limits";
import { publicUrlForKey } from "./r2";

export { MAX_UPLOAD_BYTES } from "./upload-limits";

/**
 * SVG is deliberately absent. Uploads are served from this app's own origin,
 * and an SVG can carry script — allowing them would be a stored-XSS hole.
 */
const IMAGE_TYPES = [
  { mime: "image/jpeg", ext: "jpg", matches: (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    ext: "png",
    matches: (b: Uint8Array) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/gif",
    ext: "gif",
    matches: (b: Uint8Array) =>
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: "image/webp",
    ext: "webp",
    matches: (b: Uint8Array) =>
      ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  },
  {
    mime: "image/avif",
    ext: "avif",
    matches: (b: Uint8Array) => ascii(b, 4, 8) === "ftyp" && ascii(b, 8, 12).startsWith("avi"),
  },
] as const;

export const ALLOWED_MIME_TYPES = IMAGE_TYPES.map((type) => type.mime);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

/**
 * Identifies the format from the file's own bytes rather than the browser's
 * Content-Type header, which the client controls.
 */
export function detectImageType(
  bytes: Uint8Array,
): { mime: string; ext: string } | null {
  if (bytes.length < 12) return null;
  const match = IMAGE_TYPES.find((type) => type.matches(bytes));
  return match ? { mime: match.mime, ext: match.ext } : null;
}

/** `2026/08/9f86d081-my-photo.jpg` — sorts by date, collision-free, readable. */
export function buildMediaKey(originalName: string, ext: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");

  const stem = originalName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  const unique = crypto.randomUUID().split("-")[0];
  return `${year}/${month}/${unique}${stem ? `-${stem}` : ""}.${ext}`;
}

export type UploadedMedia = {
  id: string;
  r2_key: string;
  url: string;
  alt_text: string | null;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

/**
 * Validates, stores in R2, then records the object in `media`.
 *
 * R2 is written before the database row so a failed insert leaves an orphaned
 * object rather than a row pointing at nothing — a dead byte range is cheaper
 * to live with than a broken image in a published post.
 */
export async function uploadMedia(
  db: BlogDatabase,
  bucket: R2Bucket,
  file: File,
  altText: string | null,
): Promise<UploadedMedia> {
  if (file.size === 0) throw new ApiError(422, "File is empty");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      `File is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectImageType(bytes);
  if (!detected) {
    throw new ApiError(
      422,
      `Unsupported image format. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
    );
  }

  const key = buildMediaKey(file.name || "image", detected.ext);
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: detected.mime,
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  const [row] = await db
    .insert(media)
    .values({
      r2Key: key,
      url: publicUrlForKey(key),
      altText,
      // Kept so the library is searchable by what you called the file, and so
      // a size column exists to reclaim space against.
      filename: file.name || null,
      contentType: detected.mime,
      sizeBytes: file.size,
    })
    .returning();

  return serializeMedia(row);
}

export async function listMedia(
  db: BlogDatabase,
  limit = 50,
  options: { search?: string; offset?: number } = {},
): Promise<UploadedMedia[]> {
  const term = options.search?.trim();
  // ILIKE over filename and alt text. At this scale a sequential scan is
  // nothing, and it avoids a second index that would only ever serve this box.
  const filter = term
    ? or(
        ilike(media.filename, `%${term}%`),
        ilike(media.altText, `%${term}%`),
      )
    : undefined;

  const rows = await db
    .select()
    .from(media)
    .where(filter)
    .orderBy(desc(media.createdAt))
    .limit(limit)
    .offset(options.offset ?? 0);
  return rows.map(serializeMedia);
}

export async function countMedia(db: BlogDatabase): Promise<number> {
  const [row] = await db.select({ value: count() }).from(media);
  return row?.value ?? 0;
}

export async function getMediaById(
  db: BlogDatabase,
  id: string,
): Promise<MediaRow | null> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  return row ?? null;
}

export async function setMediaAltText(
  db: BlogDatabase,
  id: string,
  altText: string | null,
): Promise<UploadedMedia> {
  const [row] = await db
    .update(media)
    .set({ altText: altText && altText.trim() !== "" ? altText.trim() : null })
    .where(eq(media.id, id))
    .returning();
  if (!row) throw notFound("Media");
  return serializeMedia(row);
}

export type MediaUsage = { kind: "post" | "page"; id: string; title: string };

/**
 * Where an image is referenced.
 *
 * Searched rather than joined. An image can be a cover, an inline `<img>` in
 * rendered HTML, or inside a page — a join table would have to be kept in step
 * with the editor on every keystroke, and would go stale the moment someone
 * pasted a URL by hand. A LIKE over the URL cannot go stale, and at this
 * scale it costs nothing.
 *
 * This is what makes deletion safe to offer: the admin can say "used in 2
 * posts" instead of silently breaking them.
 */
export async function findMediaUsage(
  db: BlogDatabase,
  url: string,
): Promise<MediaUsage[]> {
  const needle = `%${url}%`;

  const [postRows, pageRows] = await Promise.all([
    db
      .select({ id: posts.id, title: posts.title })
      .from(posts)
      .where(
        or(
          eq(posts.coverImageUrl, url),
          eq(posts.ogImageUrl, url),
          ilike(posts.contentHtml, needle),
        ),
      ),
    db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(ilike(pages.contentHtml, needle)),
  ]);

  return [
    ...postRows.map((row) => ({ kind: "post" as const, ...row })),
    ...pageRows.map((row) => ({ kind: "page" as const, ...row })),
  ];
}

/**
 * Removes the row and the R2 object.
 *
 * The database row goes first: a row pointing at a missing object is a broken
 * image, while an orphaned object is only wasted bytes. If the R2 delete
 * fails the row is already gone, which is the direction we can live with —
 * the same trade-off `uploadMedia` makes in reverse.
 */
export async function deleteMedia(
  db: BlogDatabase,
  bucket: R2Bucket,
  id: string,
): Promise<void> {
  const [row] = await db
    .delete(media)
    .where(eq(media.id, id))
    .returning({ r2Key: media.r2Key });
  if (!row) throw notFound("Media");

  try {
    await bucket.delete(row.r2Key);
  } catch (error) {
    console.warn(`Removed media row but could not delete ${row.r2Key}:`, error);
  }
}

export function serializeMedia(row: MediaRow): UploadedMedia {
  return {
    id: row.id,
    r2_key: row.r2Key,
    url: row.url,
    alt_text: row.altText,
    filename: row.filename,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
    created_at:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
