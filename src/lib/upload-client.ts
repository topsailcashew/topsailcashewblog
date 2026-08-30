"use client";

import type { UploadedMedia } from "./media";

/** Posts a file to /api/media and returns the stored object. */
export async function uploadImage(
  file: File,
  altText?: string,
): Promise<UploadedMedia> {
  const form = new FormData();
  form.set("file", file);
  if (altText) form.set("alt_text", altText);

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
