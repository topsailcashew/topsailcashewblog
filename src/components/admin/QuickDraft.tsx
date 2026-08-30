"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/** Start a post without leaving the dashboard; opens the editor on success. */
export function QuickDraft() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  function save() {
    startTransition(async () => {
      setError(null);
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || "Untitled",
          content_html: body.trim() ? `<p>${escapeHtml(body.trim())}</p>` : null,
        }),
      });

      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as { error?: string };
        setError(failure.error ?? `Could not save (${response.status})`);
        return;
      }

      const { post } = (await response.json()) as { post: { id: string } };
      setTitle("");
      setBody("");
      router.push(`/admin/posts/${post.id}`);
    });
  }

  return (
    <div className="panel">
      <h2 className="label">Quick draft</h2>
      <input
        aria-label="Post title"
        placeholder="Post Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        aria-label="Draft body"
        placeholder="Write something…"
        rows={5}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="panel-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={pending || (!title.trim() && !body.trim())}
          onClick={save}
        >
          {pending ? "Saving…" : "Save Draft"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The quick draft is plain text, so it is escaped before being wrapped in a
 * paragraph — the editor owns rich content, this box does not.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
