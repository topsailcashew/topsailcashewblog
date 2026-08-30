"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { CommentStatus } from "@/lib/comments";

const NEXT_STATUS: { label: string; status: CommentStatus }[] = [
  { label: "Approve", status: "approved" },
  { label: "Reject", status: "rejected" },
  { label: "Spam", status: "spam" },
];

/** Moderation controls for one comment, plus the reply-as-author box. */
export function CommentActions({
  commentId,
  status,
}: {
  commentId: string;
  status: CommentStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");

  function run(action: () => Promise<Response>) {
    startTransition(async () => {
      setError(null);
      const response = await action();
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${response.status})`);
        return;
      }
      setReplying(false);
      setReplyBody("");
      router.refresh();
    });
  }

  return (
    <div className="comment-admin-actions">
      <div className="row">
        {NEXT_STATUS.filter((entry) => entry.status !== status).map((entry) => (
          <button
            key={entry.status}
            type="button"
            disabled={pending}
            onClick={() =>
              run(() =>
                fetch(`/api/comments/${commentId}`, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ status: entry.status }),
                }),
              )
            }
          >
            {entry.label}
          </button>
        ))}
        <button type="button" disabled={pending} onClick={() => setReplying((v) => !v)}>
          {replying ? "Cancel reply" : "Reply"}
        </button>
      </div>

      {replying && (
        <div className="comment-admin-reply">
          <textarea
            rows={3}
            value={replyBody}
            placeholder="Your reply is published immediately and badged as the author."
            onChange={(event) => setReplyBody(event.target.value)}
          />
          <button
            type="button"
            disabled={pending || replyBody.trim() === ""}
            onClick={() =>
              run(() =>
                fetch(`/api/comments/${commentId}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ body: replyBody }),
                }),
              )
            }
          >
            Post reply
          </button>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
