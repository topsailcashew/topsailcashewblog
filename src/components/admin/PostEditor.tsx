"use client";

import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorToolbar } from "@/components/editor/EditorToolbar";
import { EMPTY_DOC, buildExtensions } from "@/components/editor/extensions";
import type { SerializedPost } from "@/lib/posts";
import type { SerializedSeries } from "@/lib/series";
import { useAutosave } from "@/lib/use-autosave";
import { isImageFile, uploadImage } from "@/lib/upload-client";
import { CoverImagePicker } from "./CoverImagePicker";
import { SaveStatus } from "./SaveStatus";
import { TagInput } from "./TagInput";

/** The fields autosave watches. `content_html` is derived at save time. */
type Draft = {
  title: string;
  slug: string;
  excerpt: string;
  coverImageUrl: string | null;
  tags: string[];
  seriesId: string | null;
  contentJson: JSONContent;
};

function draftFromPost(post: SerializedPost | null): Draft {
  return {
    title: post?.title ?? "",
    slug: post?.slug ?? "",
    excerpt: post?.excerpt ?? "",
    coverImageUrl: post?.cover_image_url ?? null,
    tags: post?.tags.map((tag) => tag.name) ?? [],
    seriesId: post?.series_id ?? null,
    contentJson: (post?.content_json as JSONContent | null) ?? EMPTY_DOC,
  };
}

export function PostEditor({
  initialPost,
  series = [],
}: {
  initialPost: SerializedPost | null;
  series?: SerializedSeries[];
}) {
  const router = useRouter();

  const [postId, setPostId] = useState<string | null>(initialPost?.id ?? null);
  const [status, setStatus] = useState(initialPost?.status ?? "draft");
  const [publishedAt, setPublishedAt] = useState(initialPost?.published_at ?? null);
  const [draft, setDraft] = useState<Draft>(() => draftFromPost(initialPost));
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Read inside save() so the HTML is generated from the live document.
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null);
  const postIdRef = useRef(postId);

  useEffect(() => {
    postIdRef.current = postId;
  }, [postId]);

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
    // Required in the App Router: rendering on the server would mismatch.
    immediatelyRender: false,
    onUpdate: ({ editor: instance }) => {
      setDraft((current) => ({ ...current, contentJson: instance.getJSON() }));
    },
    editorProps: {
      attributes: { class: "prose-editor", "aria-label": "Post body" },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(
          (event as DragEvent).dataTransfer?.files ?? [],
        ).filter(isImageFile);
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

  /** A brand-new post is only worth creating once it has something in it. */
  const hasSubstance =
    draft.title.trim() !== "" || (editor ? editor.getText().trim() !== "" : false);

  const persist = useCallback(
    async (value: Draft): Promise<Draft> => {
      const body: Record<string, unknown> = {
        title: value.title.trim() || "Untitled",
        content_json: value.contentJson,
        content_html: editorRef.current?.getHTML() ?? "",
        excerpt: value.excerpt.trim() === "" ? null : value.excerpt.trim(),
        cover_image_url: value.coverImageUrl,
        tags: value.tags,
        series_id: value.seriesId,
      };

      const id = postIdRef.current;
      // Only send a slug when the writer has actually changed it; on create the
      // API derives one from the title.
      if (id && value.slug.trim() !== "" && value.slug.trim() !== initialPost?.slug) {
        body.slug = value.slug.trim();
      }

      const response = await fetch(id ? `/api/posts/${id}` : "/api/posts", {
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

      const { post } = (await response.json()) as { post: SerializedPost };
      // The server may have adjusted the slug (derived on create, de-duplicated
      // on collision). Adopt it in both the draft and the autosave baseline.
      setDraft((current) => ({ ...current, slug: post.slug }));

      if (!id) {
        setPostId(post.id);
        postIdRef.current = post.id;
        // Swap the URL so a refresh lands on the real post rather than /new.
        // Deliberately not router.replace(): that remounts the editor, which
        // resets the save indicator to "no changes" the instant the writer's
        // first save succeeds.
        window.history.replaceState(null, "", `/admin/posts/${post.id}`);
      }

      return { ...value, slug: post.slug };
    },
    [initialPost?.slug],
  );

  const { state, isDirty, flush } = useAutosave<Draft>({
    value: draft,
    save: persist,
    // Same shape the editor loaded with, so an untouched post is not "dirty".
    baseline: useMemo(() => draftFromPost(initialPost), [initialPost]),
    enabled: hasSubstance,
  });

  const togglePublish = useCallback(async () => {
    setActionError(null);
    await flush();

    const id = postIdRef.current;
    if (!id) {
      setActionError("Add a title before publishing.");
      return;
    }

    const next = status === "published" ? "draft" : "published";
    const response = await fetch(`/api/posts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setActionError(body.error ?? `Could not ${next === "published" ? "publish" : "unpublish"}`);
      return;
    }

    const { post } = (await response.json()) as { post: SerializedPost };
    setStatus(post.status);
    setPublishedAt(post.published_at);
    router.refresh();
  }, [flush, router, status]);

  const remove = useCallback(async () => {
    const id = postIdRef.current;
    if (!id) return;
    if (!window.confirm("Delete this post? This cannot be undone.")) return;

    const response = await fetch(`/api/posts/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) {
      setActionError(`Could not delete (${response.status})`);
      return;
    }
    router.push("/admin");
  }, [router]);

  return (
    <div className="editor-page">
      <header className="editor-bar">
        <div className="row">
          <span className="pill">{status}</span>
          <SaveStatus state={state} dirty={isDirty} />
        </div>
        <div className="row">
          <button type="button" onClick={() => void flush()} disabled={!hasSubstance}>
            Save now
          </button>
          <button type="button" onClick={() => void togglePublish()} disabled={!postId}>
            {status === "published" ? "Unpublish" : "Publish"}
          </button>
          <button type="button" onClick={() => void remove()} disabled={!postId}>
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

        <label>
          Excerpt
          <textarea
            rows={3}
            value={draft.excerpt}
            placeholder="Shown in the post list and RSS."
            onChange={(event) => update("excerpt", event.target.value)}
            onBlur={() => void flush()}
          />
        </label>

        <label>
          Slug
          <input
            value={draft.slug}
            placeholder="Derived from the title on first save"
            onChange={(event) => update("slug", event.target.value)}
            onBlur={() => void flush()}
          />
        </label>

        <div className="field">
          <span className="field-label">Tags</span>
          <TagInput tags={draft.tags} onChange={(tags) => update("tags", tags)} />
        </div>

        <label>
          Series
          <select
            value={draft.seriesId ?? ""}
            onChange={(event) =>
              update("seriesId", event.target.value === "" ? null : event.target.value)
            }
            onBlur={() => void flush()}
          >
            <option value="">Not part of a series</option>
            {series.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span className="field-label">Cover image</span>
          <CoverImagePicker
            url={draft.coverImageUrl}
            onChange={(url) => update("coverImageUrl", url)}
          />
        </div>

        {publishedAt && (
          <p className="muted">
            Published {new Date(publishedAt).toLocaleString()}
          </p>
        )}
      </section>
    </div>
  );
}
