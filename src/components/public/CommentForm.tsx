"use client";

import { useState } from "react";
import { HONEYPOT_FIELD } from "@/lib/validation";

type Props = {
  postId: string;
  parentId?: string;
  /** Called once a submission is accepted, so a reply box can close itself. */
  onSubmitted?: () => void;
  compact?: boolean;
};

type State = "idle" | "sending" | "sent";

/**
 * Anyone can submit; nothing appears until it is approved. The form says so
 * plainly rather than implying the comment is live.
 */
export function CommentForm({ postId, parentId, onSubmitted, compact }: Props) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState("sending");
    setError(null);

    try {
      const response = await fetch("/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          post_id: postId,
          parent_id: parentId ?? null,
          author_name: String(form.get("author_name") ?? ""),
          author_email: String(form.get("author_email") ?? ""),
          body: String(form.get("body") ?? ""),
          [HONEYPOT_FIELD]: String(form.get(HONEYPOT_FIELD) ?? ""),
        }),
      });

      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          error?: string;
          details?: Record<string, string[]>;
        };
        const firstDetail = failure.details
          ? Object.values(failure.details)[0]?.[0]
          : undefined;
        setError(firstDetail ?? failure.error ?? "Could not post that comment.");
        setState("idle");
        return;
      }

      setState("sent");
      onSubmitted?.();
    } catch {
      setError("Could not reach the server.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <p className="comment-sent" role="status">
        Thanks — your comment is awaiting approval and will appear once it has
        been read.
      </p>
    );
  }

  return (
    <form className={compact ? "comment-form is-compact" : "comment-form"} onSubmit={submit}>
      {!compact && <h3>Leave a comment</h3>}

      <div className="comment-fields">
        <label>
          Name
          <input name="author_name" required maxLength={120} autoComplete="name" />
        </label>
        <label>
          Email
          <input
            name="author_email"
            type="email"
            required
            maxLength={320}
            autoComplete="email"
          />
          <span className="field-hint">Never published — only so I can reply.</span>
        </label>
      </div>

      <label>
        Comment
        <textarea name="body" required rows={compact ? 3 : 5} maxLength={4000} />
      </label>

      {/*
        Honeypot. Hidden from people (and from screen readers via aria-hidden),
        left in the DOM for automated clients to fill. A filled value is
        accepted with a normal response and quietly discarded.
      */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor={`${HONEYPOT_FIELD}-${parentId ?? "root"}`}>
          Leave this field empty
        </label>
        <input
          id={`${HONEYPOT_FIELD}-${parentId ?? "root"}`}
          name={HONEYPOT_FIELD}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className="row comment-actions">
        <button type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : parentId ? "Post reply" : "Post comment"}
        </button>
        <span className="muted">Comments are read before they appear.</span>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
