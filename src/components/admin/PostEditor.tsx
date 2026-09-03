"use client";

import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorToolbar } from "@/components/editor/EditorToolbar";
import {
  EMPTY_DOC,
  INSERT_IMAGE_EVENT,
  buildExtensions,
} from "@/components/editor/extensions";
import type { SerializedPost } from "@/lib/posts";
import type { SerializedSeries } from "@/lib/series";
import { useAutosave } from "@/lib/use-autosave";
import { useIsFuture } from "@/lib/use-is-future";
import { isImageFile } from "@/lib/upload-client";
import { useImageInsertion } from "@/lib/use-image-insertion";
import { CoverImagePicker } from "./CoverImagePicker";
import { EditorSection } from "./EditorSection";
import { ImageDetailsDialog } from "./ImageDetailsDialog";
import { NewsletterPanel } from "./NewsletterPanel";
import { PreviewButton } from "./PreviewButton";
import { PublishPanel } from "./PublishPanel";
import { RevisionPanel } from "./RevisionPanel";
import { SeoPanel, type SeoFields } from "./SeoPanel";
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
  featured: boolean;
  contentJson: JSONContent;
  /* SEO overrides ride along with the autosave rather than saving on their
     own — they are ordinary content fields, not a state change like publish. */
  seo: SeoFields;
};

function draftFromPost(post: SerializedPost | null): Draft {
  return {
    title: post?.title ?? "",
    slug: post?.slug ?? "",
    excerpt: post?.excerpt ?? "",
    coverImageUrl: post?.cover_image_url ?? null,
    tags: post?.tags.map((tag) => tag.name) ?? [],
    seriesId: post?.series_id ?? null,
    featured: post?.featured ?? false,
    contentJson: (post?.content_json as JSONContent | null) ?? EMPTY_DOC,
    seo: {
      metaTitle: post?.meta_title ?? "",
      metaDescription: post?.meta_description ?? "",
      canonicalUrl: post?.canonical_url ?? "",
      noindex: post?.noindex ?? false,
      ogImageUrl: post?.og_image_url ?? "",
    },
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

  const {
    uploading,
    insertImages,
    pending: pendingImage,
    confirm: confirmImage,
    cancel: cancelImage,
  } = useImageInsertion(editorRef, setActionError);

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

  /*
    ⌘⌥I opens the file picker. The shortcut lives in the ProseMirror schema
    (see buildExtensions) and announces itself as a DOM event, which is picked
    up here — so the schema stays free of anything about this component, and
    the handler is always the current one rather than the first render's.
  */
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const open = () => fileInputRef.current?.click();
    dom.addEventListener(INSERT_IMAGE_EVENT, open);
    return () => dom.removeEventListener(INSERT_IMAGE_EVENT, open);
  }, [editor]);

  /*
    "Scheduled" is not a stored status — it is `published` with a future date.
    The bar said "published" for a post nobody could read yet, so it is spelled
    out here and reused as the sidebar's collapsed summary.
  */
  // Unconditional: `&&` would short-circuit the hook on a draft.
  const dated = useIsFuture(publishedAt);
  const statusLabel = status === "published" && dated ? "scheduled" : status;

  const tagSummary =
    draft.tags.length === 0
      ? undefined
      : `${draft.tags.length} tag${draft.tags.length === 1 ? "" : "s"}`;

  // Collapsed, the section still has to say that this post leads the home
  // page — that is a site-wide effect, not a detail of this post.
  const publishSummary = draft.featured ? `${statusLabel} · featured` : statusLabel;

  /** What the SEO section shows when collapsed, so overrides are not hidden. */
  const seoSummary = (() => {
    const set = [
      draft.seo.metaTitle.trim() !== "" && "title",
      draft.seo.metaDescription.trim() !== "" && "description",
      draft.seo.canonicalUrl.trim() !== "" && "canonical",
      draft.seo.ogImageUrl.trim() !== "" && "image",
    ].filter(Boolean) as string[];
    if (draft.seo.noindex) return "hidden from search";
    return set.length > 0 ? `${set.length} set` : undefined;
  })();

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
        featured: value.featured,
        meta_title: value.seo.metaTitle.trim() || null,
        meta_description: value.seo.metaDescription.trim() || null,
        canonical_url: value.seo.canonicalUrl.trim() || null,
        noindex: value.seo.noindex,
        og_image_url: value.seo.ogImageUrl.trim() || null,
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

  /**
   * Writes the publication date on its own.
   *
   * Deliberately not part of the autosaved draft: `published_at` is the field
   * the public feed sorts and filters on, so it should move when the writer
   * changes it, not on the next ten-second tick.
   */
  const setSchedule = useCallback(
    async (isoOrNull: string | null) => {
      const id = postIdRef.current;
      if (!id) {
        setActionError("Save the post before scheduling it.");
        return;
      }
      setActionError(null);

      const response = await fetch(`/api/posts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ published_at: isoOrNull }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setActionError(body.error ?? "Could not set the publish date");
        return;
      }

      const { post } = (await response.json()) as { post: SerializedPost };
      setPublishedAt(post.published_at);
      router.refresh();
    },
    [router],
  );

  /**
   * A restore rewrites the row underneath the open editor, so the editor has
   * to be reloaded from the server rather than left showing the old text.
   */
  const reloadAfterRestore = useCallback(async () => {
    const id = postIdRef.current;
    if (!id) return;

    const response = await fetch(`/api/posts/${id}`);
    if (!response.ok) {
      setActionError("Restored, but the editor could not reload — refresh the page.");
      return;
    }
    const { post } = (await response.json()) as { post: SerializedPost };
    const restored = draftFromPost(post);
    setDraft(restored);
    editorRef.current?.commands.setContent(restored.contentJson);
    router.refresh();
  }, [router]);

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
        <div className="row editor-bar-state">
          <span className={`status--${status}`}>{statusLabel}</span>
          <SaveStatus state={state} dirty={isDirty} />
        </div>
        <div className="row editor-bar-actions">
          <PreviewButton
            postId={postId}
            slug={draft.slug}
            status={status}
            publishedAt={publishedAt}
            onBeforePreview={flush}
          />
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void flush()}
            disabled={!hasSubstance}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => void togglePublish()}
            disabled={!postId}
          >
            {status === "published" ? "Unpublish" : "Publish"}
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--small btn--danger"
            onClick={() => void remove()}
            disabled={!postId}
          >
            Trash
          </button>
        </div>
      </header>

      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      <div className="editor-columns">
        <div className="editor-main">
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

      <ImageDetailsDialog
        media={pendingImage}
        onCancel={cancelImage}
        onConfirm={(details) => void confirmImage(details)}
      />

        </div>

        <aside className="editor-sidebar" aria-label="Post settings">
          <EditorSection title="Publish" defaultOpen summary={publishSummary}>
            <PublishPanel
              postId={postId}
              status={status}
              publishedAt={publishedAt}
              featured={draft.featured}
              onScheduleChange={setSchedule}
              onFeaturedChange={(value) => {
                update("featured", value);
                void flush();
              }}
            />
          </EditorSection>

          {/* Owns its own collapsible section, so it can load on expand. */}
          <NewsletterPanel
            postId={postId}
            status={status}
            onPublished={() => {
              // A send publishes the post server-side; the bar has to catch up.
              setStatus("published");
              router.refresh();
            }}
          />

          <EditorSection
            title="Details"
            defaultOpen
            summary={tagSummary}
          >
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
          </EditorSection>

          <EditorSection title="SEO" summary={seoSummary}>
            <SeoPanel
              fields={draft.seo}
              fallbackTitle={draft.title}
              fallbackDescription={draft.excerpt}
              slug={draft.slug}
              onChange={(key, value) =>
                setDraft((current) => ({
                  ...current,
                  seo: { ...current.seo, [key]: value },
                }))
              }
              onCommit={() => void flush()}
            />
          </EditorSection>

          <RevisionPanel postId={postId} onRestored={reloadAfterRestore} />
        </aside>
      </div>
    </div>
  );
}
