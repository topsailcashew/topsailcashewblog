"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Purges every trashed post. The one genuinely irreversible action here. */
export function EmptyTrashButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (count === 0) return null;

  return (
    <button
      type="button"
      className="btn btn--small btn--danger"
      disabled={pending}
      onClick={() => {
        if (
          !window.confirm(
            `Permanently delete ${count} post${count === 1 ? "" : "s"}? This cannot be undone.`,
          )
        ) {
          return;
        }
        startTransition(async () => {
          await fetch("/api/posts/trash", { method: "DELETE" });
          router.refresh();
        });
      }}
    >
      Empty trash ({count})
    </button>
  );
}
