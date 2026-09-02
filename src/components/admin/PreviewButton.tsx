"use client";

import { useCallback, useState } from "react";
import { useIsFuture } from "@/lib/use-is-future";

/**
 * Opens the post as a reader would see it.
 *
 * A published post has a public URL already. Anything else — a draft, or a
 * post dated forward — has no readable URL at all, so this mints a signed
 * preview token and opens that instead. One button either way: which of the
 * two it needs is a detail the writer should not have to think about.
 */
export function PreviewButton({
  postId,
  slug,
  status,
  publishedAt,
  onBeforePreview,
}: {
  postId: string | null;
  slug: string;
  status: string;
  publishedAt: string | null;
  /** Flushes pending edits, so the preview shows what was just typed. */
  onBeforePreview: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = useIsFuture(publishedAt);
  const live = status === "published" && slug !== "" && !pending;

  const open = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await onBeforePreview();

      if (live) {
        window.open(`/${slug}`, "_blank", "noopener");
        return;
      }
      if (!postId) return;

      const response = await fetch(`/api/posts/${postId}/preview`, { method: "POST" });
      if (!response.ok) throw new Error(`Could not build a preview (${response.status})`);
      const { url } = (await response.json()) as { url: string };
      window.open(url, "_blank", "noopener");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open a preview");
    } finally {
      setBusy(false);
    }
  }, [live, onBeforePreview, postId, slug]);

  return (
    <>
      <button
        type="button"
        className="btn btn--small"
        disabled={!postId || busy}
        title={live ? "Open the published post" : "Open a private preview of this draft"}
        onClick={() => void open()}
      >
        {busy ? "Opening…" : "Preview"}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
