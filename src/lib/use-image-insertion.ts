"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useState, type RefObject } from "react";
import type { ImageDetails } from "@/components/admin/ImageDetailsDialog";
import type { UploadedMedia } from "./media";
import { altTextFor } from "./media-alt";
import { isImageFile, uploadImage } from "./upload-client";

/**
 * Upload, classify, insert.
 *
 * Shared by the post and page editors, which had a copy each. They had already
 * drifted in the way copies do: both inserted the *filename* as alt text when
 * none was set, which is the single worst thing to put there — it is exactly
 * what a screen reader falls back to announcing when alt is missing, so it
 * takes a fixable omission and makes it look deliberate.
 *
 * Files upload first and queue up; the dialog then asks about each in turn.
 * Uploading first means the dialog can show the image being described, and it
 * means a slow upload does not hold a modal open over the editor.
 */
export function useImageInsertion(
  editorRef: RefObject<Editor | null>,
  onError: (message: string) => void,
) {
  const [uploading, setUploading] = useState(false);
  const [queue, setQueue] = useState<UploadedMedia[]>([]);

  const insertImages = useCallback(
    async (files: File[]) => {
      const images = files.filter(isImageFile);
      if (images.length === 0) return;

      setUploading(true);
      try {
        const uploaded: UploadedMedia[] = [];
        for (const file of images) uploaded.push(await uploadImage(file));
        setQueue((current) => [...current, ...uploaded]);
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : "Image upload failed");
      } finally {
        setUploading(false);
      }
    },
    [onError],
  );

  /** Saves the classification, then puts the image in the document. */
  const confirm = useCallback(
    async (details: ImageDetails) => {
      const media = queue[0];
      setQueue((current) => current.slice(1));
      if (!media) return;

      let described = media;
      try {
        const response = await fetch(`/api/media/${media.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: details.role,
            alt_text: details.altText || null,
            long_description: details.longDescription || null,
          }),
        });
        if (response.ok) {
          described = ((await response.json()) as { media: UploadedMedia }).media;
        }
      } catch {
        // The image is uploaded and the writer is waiting. Insert it with what
        // they typed; the library can correct the record afterwards.
        described = {
          ...media,
          role: details.role,
          alt_text: details.altText || null,
          long_description: details.longDescription || null,
        };
      }

      editorRef.current
        ?.chain()
        .focus()
        // `altTextFor` is what turns a "decorative" classification into the
        // empty alt attribute that makes a screen reader skip the image.
        .setImage({ src: described.url, alt: altTextFor(described) })
        .run();
    },
    [editorRef, queue],
  );

  /**
   * Dismisses without inserting.
   *
   * The file stays in the media library rather than being deleted — the upload
   * succeeded, and silently discarding it would lose work on a slow connection
   * for the sake of tidiness.
   */
  const cancel = useCallback(() => {
    setQueue((current) => current.slice(1));
  }, []);

  return { uploading, insertImages, pending: queue[0] ?? null, confirm, cancel };
}
