"use client";

import { useCallback, useEffect, useState } from "react";
import type { UploadedMedia } from "@/lib/media";
import { isImageFile, uploadImage } from "@/lib/upload-client";

type Usage = { kind: "post" | "page"; id: string; title: string };

/**
 * Browse, search, retag and delete uploads.
 *
 * The gap this fills: until now an image could be uploaded but never found
 * again, so the same photo got re-uploaded every time it was needed and
 * nothing could be reclaimed.
 */
export function MediaLibrary() {
  const [items, setItems] = useState<UploadedMedia[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<UploadedMedia | null>(null);
  const [usage, setUsage] = useState<Usage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (search: string) => {
    setBusy(true);
    setError(null);
    try {
      const url = search.trim()
        ? `/api/media?q=${encodeURIComponent(search.trim())}`
        : "/api/media";
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load media (${response.status})`);
      const body = (await response.json()) as { media: UploadedMedia[]; total: number };
      setItems(body.media);
      setTotal(body.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load media");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // Debounced so typing does not fire a request per keystroke.
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  const open = useCallback(async (item: UploadedMedia) => {
    setSelected(item);
    setUsage(null);
    const response = await fetch(`/api/media/${item.id}`);
    if (!response.ok) return;
    const body = (await response.json()) as { usage: Usage[] };
    setUsage(body.usage);
  }, []);

  const saveAlt = useCallback(
    async (item: UploadedMedia, altText: string) => {
      setBusy(true);
      try {
        const response = await fetch(`/api/media/${item.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ alt_text: altText || null }),
        });
        if (!response.ok) throw new Error(`Could not save (${response.status})`);
        const { media } = (await response.json()) as { media: UploadedMedia };
        setSelected(media);
        setItems((current) => current.map((m) => (m.id === media.id ? media : m)));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save alt text");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const remove = useCallback(
    async (item: UploadedMedia, force: boolean) => {
      if (
        !window.confirm(
          force
            ? "Delete anyway? The posts using it will show a broken image."
            : "Delete this image? This cannot be undone.",
        )
      ) {
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/media/${item.id}${force ? "?force=1" : ""}`,
          { method: "DELETE" },
        );

        // 409 means it is still referenced; the server sends the list back so
        // the answer is "here is where", not just "no".
        if (response.status === 409) {
          const body = (await response.json()) as { error: string; usage: Usage[] };
          setUsage(body.usage);
          setError(body.error);
          return;
        }
        if (!response.ok && response.status !== 204) {
          throw new Error(`Could not delete (${response.status})`);
        }

        setSelected(null);
        setUsage(null);
        await load(query);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not delete");
      } finally {
        setBusy(false);
      }
    },
    [load, query],
  );

  const upload = useCallback(
    async (files: File[]) => {
      const images = files.filter(isImageFile);
      if (images.length === 0) return;

      setBusy(true);
      setError(null);
      try {
        for (const file of images) await uploadImage(file);
        await load(query);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Upload failed");
      } finally {
        setBusy(false);
      }
    },
    [load, query],
  );

  return (
    <div className="media-library">
      <div className="media-toolbar">
        <input
          type="search"
          className="media-search"
          placeholder="Search by filename or alt text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search media"
        />
        <label className="btn btn--small media-upload">
          Upload
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              void upload(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </label>
        <span className="meta">
          {query ? `${items.length} of ${total}` : `${total} image${total === 1 ? "" : "s"}`}
        </span>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {busy && <p className="hint">Working…</p>}

      {!busy && items.length === 0 && (
        <p className="muted">
          {query ? "Nothing matches that." : "No uploads yet."}
        </p>
      )}

      <ul className="media-library-grid">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={selected?.id === item.id ? "media-tile is-active" : "media-tile"}
              onClick={() => void open(item)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.url} alt={item.alt_text ?? ""} loading="lazy" />
              <span className="media-tile-name">{item.filename ?? item.r2_key}</span>
              {!item.alt_text && (
                <span className="media-tile-warn" title="No alt text">
                  no alt
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <MediaDetail
          item={selected}
          usage={usage}
          busy={busy}
          onClose={() => {
            setSelected(null);
            setUsage(null);
            setError(null);
          }}
          onSaveAlt={(alt) => void saveAlt(selected, alt)}
          onDelete={(force) => void remove(selected, force)}
        />
      )}
    </div>
  );
}

function MediaDetail({
  item,
  usage,
  busy,
  onClose,
  onSaveAlt,
  onDelete,
}: {
  item: UploadedMedia;
  usage: Usage[] | null;
  busy: boolean;
  onClose: () => void;
  onSaveAlt: (altText: string) => void;
  onDelete: (force: boolean) => void;
}) {
  const [alt, setAlt] = useState(item.alt_text ?? "");
  const inUse = usage !== null && usage.length > 0;

  return (
    <aside className="media-detail" aria-label="Image details">
      <div className="media-detail-head">
        {/* Not `.label`: that small-caps a filename, and case can matter in one. */}
        <h2 className="media-detail-name">{item.filename ?? "Image"}</h2>
        <button type="button" className="btn btn--quiet btn--small" onClick={onClose}>
          Close
        </button>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="media-detail-image" src={item.url} alt={item.alt_text ?? ""} />

      <p className="meta">
        {item.content_type ?? "image"} · {formatBytes(item.size_bytes)} ·{" "}
        {new Date(item.created_at).toLocaleDateString()}
      </p>

      <label>
        Alt text
        <textarea
          rows={2}
          value={alt}
          placeholder="Describe the image for screen readers"
          onChange={(event) => setAlt(event.target.value)}
          onBlur={() => onSaveAlt(alt)}
        />
      </label>

      <label>
        URL
        <input readOnly value={item.url} onFocus={(e) => e.target.select()} />
      </label>

      <div className="media-usage">
        <span className="field-label">Used in</span>
        {usage === null && <p className="hint">Checking…</p>}
        {usage !== null && usage.length === 0 && (
          <p className="hint">Nothing references this image.</p>
        )}
        {inUse && (
          <ul className="media-usage-list">
            {usage.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`}>
                <a
                  href={
                    entry.kind === "post"
                      ? `/admin/posts/${entry.id}`
                      : `/admin/pages/${entry.id}`
                  }
                >
                  {entry.title}
                </a>{" "}
                <span className="meta">{entry.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        className="btn btn--small btn--danger"
        disabled={busy}
        onClick={() => onDelete(inUse)}
      >
        {inUse ? "Delete anyway" : "Delete"}
      </button>
    </aside>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
