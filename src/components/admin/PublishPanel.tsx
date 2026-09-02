"use client";

import { useCallback, useState } from "react";
import { useIsFuture } from "@/lib/use-is-future";

/**
 * Publication controls: when the post goes live, and a share link for a draft.
 *
 * Scheduling is a date, not a separate state. A post is "scheduled" when it is
 * published with a `published_at` in the future — the public queries filter on
 * that time, so there is no queue to drain and no cron job to miss.
 */
export function PublishPanel({
  postId,
  status,
  publishedAt,
  onScheduleChange,
}: {
  postId: string | null;
  status: string;
  publishedAt: string | null;
  onScheduleChange: (isoOrNull: string | null) => void | Promise<void>;
}) {
  const [linkState, setLinkState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "ready"; url: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const dated = useIsFuture(publishedAt);
  const scheduled = status === "published" && dated;

  const makeLink = useCallback(async () => {
    if (!postId) return;
    setLinkState({ kind: "busy" });
    try {
      const response = await fetch(`/api/posts/${postId}/preview`, { method: "POST" });
      if (!response.ok) throw new Error(`Could not create a link (${response.status})`);

      const { url } = (await response.json()) as { url: string };
      // Clipboard access can be refused; the link is rendered either way so it
      // can be copied by hand.
      await navigator.clipboard?.writeText(url).catch(() => {});
      setLinkState({ kind: "ready", url });
    } catch (cause) {
      setLinkState({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Could not create a link",
      });
    }
  }, [postId]);

  return (
    <div className="publish-panel">
      {scheduled && publishedAt && (
        <p className="publish-scheduled">
          Scheduled for {new Date(publishedAt).toLocaleString()}
        </p>
      )}

      <label className="publish-date">
        {status === "published" ? "Publish date" : "Publish date (once published)"}
        <input
          type="datetime-local"
          value={toLocalInput(publishedAt)}
          onChange={(event) => void onScheduleChange(fromLocalInput(event.target.value))}
        />
      </label>
      <p className="hint">
        A future date holds the post back until then. Leave it empty to stamp
        the moment you publish.
      </p>

      <button
        type="button"
        className="btn btn--quiet btn--small"
        onClick={() => void makeLink()}
        disabled={!postId || linkState.kind === "busy"}
      >
        {linkState.kind === "busy" ? "Creating…" : "Copy preview link"}
      </button>

      {linkState.kind === "ready" && (
        <p className="hint">
          Copied. Anyone with this link can read the draft; it expires in a week.
          <input className="preview-link" readOnly value={linkState.url} />
        </p>
      )}
      {linkState.kind === "error" && (
        <p className="error" role="alert">
          {linkState.message}
        </p>
      )}
    </div>
  );
}

/** ISO instant -> the `YYYY-MM-DDTHH:mm` a datetime-local input expects, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** The input's local wall-clock time back to an absolute instant. */
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
