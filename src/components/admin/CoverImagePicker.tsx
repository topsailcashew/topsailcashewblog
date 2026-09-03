"use client";

import { useRef, useState } from "react";
import { uploadImage } from "@/lib/upload-client";
import { CoverGenerator } from "./CoverGenerator";

/** Separate from inline images: this one writes `posts.cover_image_url`. */
export function CoverImagePicker({
  url,
  onChange,
  disabled,
  postId,
  postSlug,
  aiReady,
  onBeforeGenerate,
}: {
  url: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
  /** Generation needs a saved post to read. */
  postId?: string | null;
  postSlug?: string;
  aiReady?: boolean;
  onBeforeGenerate?: () => Promise<unknown>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const media = await uploadImage(file);
      onChange(media.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  /*
    The generator replaces the picker's body while it is open. No new sidebar
    section: the cover already has a home, and a second competing place for it
    would be worse than the feature is good.
  */
  if (generating && postId) {
    return (
      <CoverGenerator
        postId={postId}
        postSlug={postSlug ?? ""}
        onBeforeRun={onBeforeGenerate ?? (async () => {})}
        onCancel={() => setGenerating(false)}
        onAccept={(next) => {
          onChange(next);
          setGenerating(false);
        }}
      />
    );
  }

  return (
    <div className="cover-picker">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Cover" className="cover-preview" />
      ) : (
        <p className="muted">No cover image.</p>
      )}

      <div className="row">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : url ? "Replace cover" : "Upload cover"}
        </button>
        {aiReady && postId && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => setGenerating(true)}
          >
            Generate
          </button>
        )}
        {url && (
          <button type="button" disabled={disabled || busy} onClick={() => onChange(null)}>
            Remove
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
