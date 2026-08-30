import { desc } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { media, type MediaRow } from "@/db/schema";
import { ApiError } from "./http";
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
    .values({ r2Key: key, url: publicUrlForKey(key), altText })
    .returning();

  return serializeMedia(row);
}

export async function listMedia(
  db: BlogDatabase,
  limit = 50,
): Promise<UploadedMedia[]> {
  const rows = await db
    .select()
    .from(media)
    .orderBy(desc(media.createdAt))
    .limit(limit);
  return rows.map(serializeMedia);
}

export function serializeMedia(row: MediaRow): UploadedMedia {
  return {
    id: row.id,
    r2_key: row.r2Key,
    url: row.url,
    alt_text: row.altText,
    created_at:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
