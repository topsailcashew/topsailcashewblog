"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * Row actions for the admin post tables.
 *
 * In the trash the actions invert: restore, or delete for good. Everywhere
 * else "Delete" is the recoverable one, and says so — the old copy warned
 * "this cannot be undone", which is now only true of the trash view.
 */
export function PostRowActions({
  id,
  title,
  trashed = false,
}: {
  id: string;
  title: string;
  trashed?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<Response>) =>
    startTransition(async () => {
      await action();
      router.refresh();
    });

  if (trashed) {
    return (
      <span className="row-actions">
        <button
          type="button"
          className="btn btn--small"
          aria-label={`Restore ${title}`}
          disabled={pending}
          onClick={() => run(() => fetch(`/api/posts/${id}/restore`, { method: "POST" }))}
        >
          Restore
        </button>
        <button
          type="button"
          className="btn btn--small btn--danger"
          aria-label={`Permanently delete ${title}`}
          disabled={pending}
          onClick={() => {
            if (
              !window.confirm(
                `Permanently delete "${title}"? This cannot be undone.`,
              )
            ) {
              return;
            }
            run(() => fetch(`/api/posts/${id}?permanent=1`, { method: "DELETE" }));
          }}
        >
          Delete forever
        </button>
      </span>
    );
  }

  return (
    <span className="row-actions">
      <button
        type="button"
        className="btn btn--small"
        title={`Edit ${title}`}
        aria-label={`Edit ${title}`}
        onClick={() => router.push(`/admin/posts/${id}`)}
      >
        Edit
      </button>
      <button
        type="button"
        className="btn btn--small btn--danger"
        title={`Move ${title} to the trash`}
        aria-label={`Move ${title} to the trash`}
        disabled={pending}
        onClick={() => run(() => fetch(`/api/posts/${id}`, { method: "DELETE" }))}
      >
        Trash
      </button>
    </span>
  );
}
