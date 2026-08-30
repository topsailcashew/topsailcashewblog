"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SerializedSeries } from "@/lib/series";

/** Create, rename and delete series. Deleting frees its posts, it does not delete them. */
export function SeriesManager({ series }: { series: SerializedSeries[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  function run(action: () => Promise<Response>) {
    startTransition(async () => {
      setError(null);
      const response = await action();
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${response.status})`);
        return;
      }
      setTitle("");
      setDescription("");
      setEditing(null);
      router.refresh();
    });
  }

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          run(() =>
            fetch("/api/series", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title, description: description || null }),
            }),
          );
        }}
      >
        <div className="row">
          <input
            aria-label="Series title"
            placeholder="New series title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            style={{ flex: 1, minWidth: "14rem" }}
          />
          <input
            aria-label="Series description"
            placeholder="Description (optional)"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            style={{ flex: 1, minWidth: "14rem" }}
          />
          <button type="submit" disabled={pending || !title.trim()}>
            Create
          </button>
        </div>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {series.length === 0 ? (
        <p className="muted">No series yet.</p>
      ) : (
        <ul className="post-rows">
          {series.map((entry) => (
            <li key={entry.id} className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                {editing === entry.id ? (
                  <input
                    aria-label={`Rename ${entry.title}`}
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    style={{ flex: 1 }}
                  />
                ) : (
                  <strong>{entry.title}</strong>
                )}
                <span className="pill">
                  {entry.post_count} published
                </span>
              </div>
              <p className="muted">
                /series/{entry.slug}
                {entry.description && ` · ${entry.description}`}
              </p>
              <div className="row">
                {editing === entry.id ? (
                  <>
                    <button
                      type="button"
                      disabled={pending || !draftTitle.trim()}
                      onClick={() =>
                        run(() =>
                          fetch(`/api/series/${entry.id}`, {
                            method: "PATCH",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ title: draftTitle }),
                          }),
                        )
                      }
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setEditing(entry.id);
                      setDraftTitle(entry.title);
                    }}
                  >
                    Rename
                  </button>
                )}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Delete "${entry.title}"? Its posts stay, but lose their series.`,
                      )
                    )
                      return;
                    run(() => fetch(`/api/series/${entry.id}`, { method: "DELETE" }));
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
