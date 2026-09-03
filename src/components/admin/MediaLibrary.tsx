"use client";

import { useCallback, useEffect, useState } from "react";
import type { MediaRole } from "@/db/schema";
import type { UploadedMedia } from "@/lib/media";
import { altTextFor, isImageFile, uploadImage } from "@/lib/upload-client";

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

  /**
   * Fetches a page of the library.
   *
   * `append` is what makes "Load more" work: the API has always accepted
   * `?offset=` and returned a true `total`, but this component only ever asked
   * for the first page — so with 84 uploads it rendered "84 images" above a
   * grid of 60 and there was no way to reach the rest.
   */
  const load = useCallback(
    async (search: string, offset = 0, append = false) => {
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("q", search.trim());
        if (offset > 0) params.set("offset", String(offset));
        const query = params.toString();

        const response = await fetch(query ? `/api/media?${query}` : "/api/media");
        if (!response.ok) throw new Error(`Could not load media (${response.status})`);

        const body = (await response.json()) as {
          media: UploadedMedia[];
          total: number;
        };
        setItems((current) => (append ? [...current, ...body.media] : body.media));
        setTotal(body.total);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load media");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

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

  const saveDetails = useCallback(
    async (
      item: UploadedMedia,
      patch: { alt_text?: string | null; role?: MediaRole; long_description?: string | null },
    ) => {
      setBusy(true);
      try {
        const response = await fetch(`/api/media/${item.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error(`Could not save (${response.status})`);
        const { media } = (await response.json()) as { media: UploadedMedia };
        setSelected(media);
        setItems((current) => current.map((m) => (m.id === media.id ? media : m)));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save");
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
              <img
                src={item.url}
                alt={altTextFor(item)}
                loading="lazy"
                width={item.width ?? undefined}
                height={item.height ?? undefined}
                // The blur stands in until the full image paints, and holds
                // the tile's shape so the grid does not jump.
                style={
                  item.lqip
                    ? { backgroundImage: `url(${item.lqip})`, backgroundSize: "cover" }
                    : undefined
                }
              />
              <span className="media-tile-name">{item.filename ?? item.r2_key}</span>
              {/*
                Only informative and functional images need text. Flagging a
                decorative one for having none would train the eye to ignore
                the warning that matters.
              */}
              {!item.alt_text && item.role !== "decorative" && (
                <span className="media-tile-warn" title="No alt text">
                  no alt
                </span>
              )}
              {item.role === "decorative" && (
                <span className="media-tile-role" title="Decorative — screen readers skip it">
                  decorative
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {items.length < total && (
        <div className="media-more">
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() => void load(query, items.length, true)}
          >
            {busy ? "Loading…" : `Load ${Math.min(60, total - items.length)} more`}
          </button>
        </div>
      )}

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
          onSave={(patch) => void saveDetails(selected, patch)}
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
  onSave,
  onDelete,
}: {
  item: UploadedMedia;
  usage: Usage[] | null;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: {
    alt_text?: string | null;
    role?: MediaRole;
    long_description?: string | null;
  }) => void;
  onDelete: (force: boolean) => void;
}) {
  const [alt, setAlt] = useState(item.alt_text ?? "");
  const [longDescription, setLongDescription] = useState(item.long_description ?? "");
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
      <img className="media-detail-image" src={item.url} alt={altTextFor(item)} />

      <p className="meta">
        {item.content_type ?? "image"} · {formatBytes(item.size_bytes)}
        {item.width && item.height ? ` · ${item.width}×${item.height}` : ""} ·{" "}
        {new Date(item.created_at).toLocaleDateString()}
      </p>

      {item.exif && <ExifSummary exif={item.exif} />}

      <label>
        Role
        <select
          value={item.role}
          onChange={(event) => onSave({ role: event.target.value as MediaRole })}
        >
          <option value="informative">Informative — carries meaning</option>
          <option value="decorative">Decorative — screen readers skip it</option>
          <option value="functional">Functional — acts as a link or button</option>
          <option value="complex">Complex — needs a longer account</option>
        </select>
      </label>

      {item.role === "decorative" ? (
        <p className="hint">
          Rendered with <code>alt=&quot;&quot;</code>. Change the role above to
          give it text.
        </p>
      ) : (
        <label>
          {item.role === "functional" ? "What does it do?" : "Alt text"}
          <textarea
            rows={2}
            value={alt}
            placeholder={
              item.role === "functional"
                ? "The action, not the picture"
                : "What a reader who cannot see it would need to know"
            }
            onChange={(event) => setAlt(event.target.value)}
            onBlur={() => onSave({ alt_text: alt || null })}
          />
        </label>
      )}

      {item.role === "complex" && (
        <label>
          Long description
          <textarea
            rows={4}
            value={longDescription}
            placeholder="The figures, the trend, the thing the chart is evidence for."
            onChange={(event) => setLongDescription(event.target.value)}
            onBlur={() => onSave({ long_description: longDescription || null })}
          />
        </label>
      )}

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

/**
 * The camera fields, when there are any.
 *
 * Read from the file at upload and shown here rather than anywhere public:
 * it is useful for finding "the one shot on the 35mm", and it is nobody's
 * business what camera the author owns. GPS is never extracted at all — see
 * src/lib/image-metadata.ts.
 */
function ExifSummary({ exif }: { exif: NonNullable<UploadedMedia["exif"]> }) {
  const parts = [
    [exif.make, exif.model].filter(Boolean).join(" "),
    exif.lens,
    exif.focal_length,
    exif.aperture,
    exif.exposure,
    exif.iso ? `ISO ${exif.iso}` : null,
    exif.taken_at ? new Date(exif.taken_at).toLocaleDateString() : null,
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0) return null;
  return <p className="meta media-exif">{parts.join(" · ")}</p>;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
