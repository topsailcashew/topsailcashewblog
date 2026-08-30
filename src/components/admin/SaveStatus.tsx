"use client";

import { useEffect, useState } from "react";
import type { SaveState } from "@/lib/use-autosave";

/** Never fails silently: an error stays on screen until the next good save. */
export function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  const [, forceTick] = useState(0);

  // Keeps the "saved 2m ago" label honest without re-rendering the editor.
  useEffect(() => {
    if (state.status !== "saved") return;
    const timer = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [state.status]);

  if (state.status === "saving") {
    return <span className="save-status is-saving">Saving…</span>;
  }
  if (state.status === "error") {
    return (
      <span className="save-status is-error" role="alert">
        Not saved — {state.message}
      </span>
    );
  }
  if (state.status === "saved") {
    return (
      <span className="save-status is-saved">
        {dirty ? "Unsaved changes" : `Saved ${relativeTime(state.at)}`}
      </span>
    );
  }
  return (
    <span className="save-status">{dirty ? "Unsaved changes" : "No changes yet"}</span>
  );
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
