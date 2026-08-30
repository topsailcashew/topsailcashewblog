"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Edit and delete for one row of the dashboard's story table. */
export function PostRowActions({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <span className="row-actions">
      <button
        type="button"
        title={`Edit ${title}`}
        aria-label={`Edit ${title}`}
        onClick={() => router.push(`/admin/posts/${id}`)}
      >
        Edit
      </button>
      <button
        type="button"
        title={`Delete ${title}`}
        aria-label={`Delete ${title}`}
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
          startTransition(async () => {
            await fetch(`/api/posts/${id}`, { method: "DELETE" });
            router.refresh();
          });
        }}
      >
        Delete
      </button>
    </span>
  );
}
