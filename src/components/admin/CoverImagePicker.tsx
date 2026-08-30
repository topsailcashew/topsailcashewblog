"use client";

import { useRef, useState } from "react";
import { uploadImage } from "@/lib/upload-client";

/** Separate from inline images: this one writes `posts.cover_image_url`. */
export function CoverImagePicker({
  url,
  onChange,
  disabled,
}: {
  url: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
