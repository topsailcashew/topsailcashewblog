"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

/**
 * Removes a subscriber outright.
 *
 * Deliberately worded as deletion rather than unsubscribing. Unsubscribing is
 * the reader's own action, taken from an email; this is the operator's, and it
 * takes the event history with it — which is what an erasure request actually
 * asks for.
 */
export function SubscriberRowActions({ id, email }: { id: string; email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = useCallback(async () => {
    if (!window.confirm(`Delete ${email} and their entire history? This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/subscribers/${id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Could not delete (${response.status})`);
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }, [email, id, router]);

  return (
    <span className="row row--tight">
      <button
        type="button"
        className="btn btn--quiet btn--small btn--danger"
        onClick={() => void remove()}
        disabled={busy}
      >
        {busy ? "…" : "Delete"}
      </button>
      {error && <span className="error-inline">{error}</span>}
    </span>
  );
}
