"use client";

import type { MediaRole } from "@/db/schema";
import { buildPlaceholder } from "./image-placeholder";
import type { UploadedMedia } from "./media";

export { altTextFor } from "./media-alt";

/**
 * Posts a file to /api/media and returns the stored object.
 *
 * The blur placeholder is computed here, before the request, because it needs
 * a pixel decode the Worker cannot do. It is best-effort and never blocks:
 * `buildPlaceholder` resolves to null rather than throwing, and the upload
 * goes ahead without it.
 */
export async function uploadImage(
  file: File,
  options: { altText?: string; role?: MediaRole; longDescription?: string } = {},
): Promise<UploadedMedia> {
  const form = new FormData();
  form.set("file", file);
  if (options.altText) form.set("alt_text", options.altText);
  if (options.role) form.set("role", options.role);
  if (options.longDescription) form.set("long_description", options.longDescription);

  const placeholder = await buildPlaceholder(file);
  if (placeholder) {
    form.set(
      "metadata",
      JSON.stringify({
        width: placeholder.width,
        height: placeholder.height,
        ...(placeholder.blurhash ? { blurhash: placeholder.blurhash } : {}),
        ...(placeholder.lqip ? { lqip: placeholder.lqip } : {}),
      }),
    );
  }

  const response = await fetch("/api/media", { method: "POST", body: form });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Upload failed (${response.status})`);
  }

  const { media } = (await response.json()) as { media: UploadedMedia };
  return media;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}
