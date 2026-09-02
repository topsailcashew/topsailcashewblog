"use client";

import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorToolbar } from "@/components/editor/EditorToolbar";
import { EMPTY_DOC, buildExtensions } from "@/components/editor/extensions";
import type { SerializedPage } from "@/lib/pages";
import { isImageFile, uploadImage } from "@/lib/upload-client";
import { useAutosave } from "@/lib/use-autosave";
import { CoverImagePicker } from "./CoverImagePicker";
import { SaveStatus } from "./SaveStatus";

/**
 * Editor for a standalone page — About, Newsletter, Contact.
 *
 * The same Tiptap surface as a post, minus everything a page has no use for:
 * no tags, series, cover, excerpt or publication date. Sharing the editor
 * component instead would mean threading "is this a page?" through every one
 * of those controls.
 */
type Draft = {
  title: string;
  slug: string;
  coverImageUrl: string | null;
  contentJson: JSONContent;
};

function draftFromPage(page: SerializedPage | null): Draft {
  return {
    title: page?.title ?? "",
    slug: page?.slug ?? "",
    coverImageUrl: page?.cover_image_url ?? null,
    contentJson: (page?.content_json as JSONContent | null) ?? EMPTY_DOC,
  };
}

export function PageEditor({ initialPage }: { initialPage: SerializedPage | null }) {
  const router = useRouter();

  const [pageId, setPageId] = useState<string | null>(initialPage?.id ?? null);
  const [status, setStatus] = useState(initialPage?.status ?? "draft");
  const [draft, setDraft] = useState<Draft>(() => draftFromPage(initialPage));
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null);
  const pageIdRef = useRef(pageId);

  useEffect(() => {
    pageIdRef.current = pageId;
  }, [pageId]);

  const update = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const insertImages = useCallback(async (files: File[]) => {
    const editor = editorRef.current;
    const images = files.filter(isImageFile);
    if (!editor || images.length === 0) return;

    setUploading(true);
    setActionError(null);
    try {
      for (const file of images) {
        const media = await uploadImage(file);
        editor
          .chain()
          .focus()
          .setImage({ src: media.url, alt: media.alt_text ?? file.name })
          .run();
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Image upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  const editor = useEditor({
    extensions: useMemo(() => buildExtensions(), []),
    content: draft.contentJson,
    immediatelyRender: false,
    onUpdate: ({ editor: instance }) => {
      setDraft((current) => ({ ...current, contentJson: instance.getJSON() }));
    },
    editorProps: {
      attributes: { class: "prose-editor", "aria-label": "Page body" },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const hasSubstance =
    draft.title.trim() !== "" || (editor ? editor.getText().trim() !== "" : false);

  const persist = useCallback(
    async (value: Draft): Promise<Draft> => {
      const body: Record<string, unknown> = {
        title: value.title.trim() || "Untitled",
        content_json: value.contentJson,
        content_html: editorRef.current?.getHTML() ?? "",
        cover_image_url: value.coverImageUrl,
      };

      const id = pageIdRef.current;
      if (id && value.slug.trim() !== "" && value.slug.trim() !== initialPage?.slug) {
        body.slug = value.slug.trim();
      }

      const response = await fetch(id ? `/api/pages/${id}` : "/api/pages", {
        method: id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          error?: string;
          details?: Record<string, string[]>;
        };
        const detail = failure.details
          ? Object.entries(failure.details)
              .map(([field, messages]) => `${field}: ${messages.join(", ")}`)
              .join("; ")
          : null;
        throw new Error(detail ?? failure.error ?? `Save failed (${response.status})`);
      }

      const { page } = (await response.json()) as { page: SerializedPage };
      setDraft((current) => ({ ...current, slug: page.slug }));

      if (!id) {
        setPageId(page.id);
        pageIdRef.current = page.id;
        window.history.replaceState(null, "", `/admin/pages/${page.id}`);
      }

      return { ...value, slug: page.slug };
    },
    [initialPage?.slug],
  );

  const { state, isDirty, flush } = useAutosave<Draft>({
    value: draft,
    save: persist,
    baseline: useMemo(() => draftFromPage(initialPage), [initialPage]),
    enabled: hasSubstance,
  });

  const togglePublish = useCallback(async () => {
    setActionError(null);
    await flush();

    const id = pageIdRef.current;
    if (!id) {
      setActionError("Add a title before publishing.");
      return;
    }

    const next = status === "published" ? "draft" : "published";
    const response = await fetch(`/api/pages/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setActionError(body.error ?? "Could not change the status");
      return;
    }

    const { page } = (await response.json()) as { page: SerializedPage };
    setStatus(page.status);
    router.refresh();
  }, [flush, router, status]);

  const remove = useCallback(async () => {
    const id = pageIdRef.current;
    if (!id) return;
    if (!window.confirm("Delete this page? This cannot be undone.")) return;

    const response = await fetch(`/api/pages/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) {
      setActionError(`Could not delete (${response.status})`);
      return;
    }
    router.push("/admin/pages");
  }, [router]);

  return (
    <div className="editor-page">
      <header className="editor-bar">
        <div className="row">
          <span className={`status--${status}`}>{status}</span>
          <SaveStatus state={state} dirty={isDirty} />
        </div>
        <div className="row">
          <button type="button" onClick={() => void flush()} disabled={!hasSubstance}>
            Save now
          </button>
          <button type="button" onClick={() => void togglePublish()} disabled={!pageId}>
            {status === "published" ? "Unpublish" : "Publish"}
          </button>
          <button type="button" onClick={() => void remove()} disabled={!pageId}>
            Delete
          </button>
        </div>
      </header>

      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      <input
        className="title-input"
        aria-label="Title"
        placeholder="Title"
        value={draft.title}
        onChange={(event) => update("title", event.target.value)}
        onBlur={() => void flush()}
      />

      {!hasSubstance && (
        <p className="muted">Add a title or start writing — autosave begins then.</p>
      )}

      {editor && (
        <>
          <EditorToolbar
            editor={editor}
            busy={uploading}
            onPickImage={() => fileInputRef.current?.click()}
          />
          <EditorContent editor={editor} />
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void insertImages(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      <section className="sidebar">
        <h2>Details</h2>

        <div className="field">
          <span className="field-label">Cover image</span>
          <CoverImagePicker
            url={draft.coverImageUrl}
            onChange={(url) => update("coverImageUrl", url)}
          />
          <p className="hint">
            The About page uses this as its portrait, laid over the heading. A
            cut-out on a transparent background works best.
          </p>
        </div>

        <label>
          Slug
          <input
            value={draft.slug}
            placeholder="Derived from the title on first save"
            onChange={(event) => update("slug", event.target.value)}
            onBlur={() => void flush()}
          />
        </label>
        <p className="hint">
          The page lives at /{draft.slug || "…"}. Changing this breaks any link
          already pointing at the old address, including the site nav.
        </p>
      </section>
    </div>
  );
}
