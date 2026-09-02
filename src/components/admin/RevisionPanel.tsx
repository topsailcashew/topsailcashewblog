"use client";

import { useCallback, useState } from "react";
import type { SerializedRevision } from "@/lib/revisions";
import { EditorSection } from "./EditorSection";

/**
 * Snapshot history for one post.
 *
 * Loaded on demand rather than with the page: most editing sessions never open
 * it, and fetching a list nobody looks at would cost a query on every load.
 * The section's first expansion is what triggers the fetch.
 */
export function RevisionPanel({
  postId,
  onRestored,
}: {
  postId: string | null;
  onRestored: () => void | Promise<void>;
}) {
  const [revisions, setRevisions] = useState<SerializedRevision[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!postId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/posts/${postId}/revisions`);
      if (!response.ok) throw new Error(`Could not load history (${response.status})`);
      const body = (await response.json()) as { revisions: SerializedRevision[] };
      setRevisions(body.revisions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load history");
    } finally {
      setBusy(false);
    }
  }, [postId]);

  const restore = useCallback(
    async (revisionId: string) => {
      if (!postId) return;
      if (
        !window.confirm(
          "Restore this version? The current text is snapshotted first, so this is undoable.",
        )
      ) {
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/posts/${postId}/revisions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision_id: revisionId }),
        });
        if (!response.ok) throw new Error(`Could not restore (${response.status})`);
        await load();
        await onRestored();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not restore");
      } finally {
        setBusy(false);
      }
    },
    [load, onRestored, postId],
  );

  if (!postId) return null;

  return (
    <EditorSection
      title="History"
      summary={revisions === null ? undefined : `${revisions.length}`}
      onOpen={() => {
        if (revisions === null) void load();
      }}
    >
      <div className="revision-panel">
          {busy && <p className="hint">Working…</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {revisions !== null && revisions.length === 0 && (
            <p className="hint">
              No snapshots yet. One is taken when you publish, and at most once
              an hour while you write.
            </p>
          )}
          {revisions !== null && revisions.length > 0 && (
            <ul className="revision-list">
              {revisions.map((revision) => (
                <li key={revision.id}>
                  <span className="revision-meta">
                    <span className="revision-when">
                      {new Date(revision.created_at).toLocaleString()}
                    </span>
                    <span className="revision-reason">{REASONS[revision.reason]}</span>
                  </span>
                  <span className="revision-title">{revision.title}</span>
                  <button
                    type="button"
                    className="btn btn--quiet btn--small"
                    onClick={() => void restore(revision.id)}
                    disabled={busy}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </EditorSection>
  );
}

const REASONS: Record<SerializedRevision["reason"], string> = {
  edit: "while writing",
  publish: "before publishing",
  unpublish: "before unpublishing",
  restore: "before a restore",
};
