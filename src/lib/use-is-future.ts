"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether an instant is still ahead of us.
 *
 * The clock is an external system: it moves without React's involvement, so
 * reading `Date.now()` during render produces a value that changes on any
 * re-render. Subscribing to it instead makes the reading stable *and* makes
 * anything derived from it — a "Scheduled for…" banner, a status label —
 * correct itself when the moment arrives, rather than waiting for some
 * unrelated render.
 */
export function useIsFuture(iso: string | null): boolean {
  const target = iso ? new Date(iso).getTime() : null;
  return useSyncExternalStore(
    subscribeToClock,
    () => target !== null && !Number.isNaN(target) && target > Date.now(),
    // Nothing reads as scheduled until the client has a clock of its own.
    () => false,
  );
}

const CLOCK_TICK_MS = 30_000;

function subscribeToClock(onChange: () => void): () => void {
  const timer = setInterval(onChange, CLOCK_TICK_MS);
  return () => clearInterval(timer);
}
