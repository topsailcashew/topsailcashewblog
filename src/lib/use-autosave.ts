"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; at: number }
  | { status: "error"; message: string };

/** How long after a change we wait before writing. */
export const AUTOSAVE_INTERVAL_MS = 10_000;

type Options<T> = {
  /** Current value. Autosave fires when its serialization changes. */
  value: T;
  /**
   * Persists the value. Rejecting surfaces as an error state.
   *
   * May return the canonical value the server settled on (e.g. with a
   * server-assigned slug). That becomes the new baseline, so a field written
   * back during the save does not immediately look like an unsaved edit.
   */
  save: (value: T) => Promise<T | void>;
  /** What was already persisted when the editor opened. Captured once. */
  baseline: T;
  /** Skip saving entirely (e.g. an untitled, empty new post). */
  enabled?: boolean;
  intervalMs?: number;
};

/**
 * Saves `value` at most once per `intervalMs` while it keeps changing, and
 * flushes immediately on blur, tab hide, and unmount.
 *
 * Dirtiness is compared on JSON rather than identity, so a re-render that
 * produces an equal document does not count as a change.
 */
export function useAutosave<T>({
  value,
  save,
  baseline,
  enabled = true,
  intervalMs = AUTOSAVE_INTERVAL_MS,
}: Options<T>) {
  const [state, setState] = useState<SaveState>({ status: "idle" });

  // What the server currently holds. State drives the UI; the ref is what
  // `flush` compares against, since it may run before a re-render.
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(baseline));
  const savedRef = useRef(savedSnapshot);

  const snapshot = useMemo(() => JSON.stringify(value), [value]);
  const isDirty = snapshot !== savedSnapshot;

  const valueRef = useRef(value);
  const saveRef = useRef(save);
  const enabledRef = useRef(enabled);
  const inFlightRef = useRef(false);
  // Set when a change lands mid-save, so we save again once it settles.
  const rerunRef = useRef(false);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const flush = useCallback(async (): Promise<void> => {
    if (!enabledRef.current) return;

    // A save already running will pick up newer edits on its next lap.
    if (inFlightRef.current) {
      rerunRef.current = true;
      return;
    }

    inFlightRef.current = true;
    try {
      do {
        rerunRef.current = false;

        const pending = JSON.stringify(valueRef.current);
        if (savedRef.current === pending) break;

        setState({ status: "saving" });
        try {
          const canonical = await saveRef.current(valueRef.current);
          const settled = canonical === undefined ? pending : JSON.stringify(canonical);
          savedRef.current = settled;
          setSavedSnapshot(settled);
          setState({ status: "saved", at: Date.now() });
        } catch (error) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not save",
          });
          // Stop rather than spin: the next edit or interval will retry.
          break;
        }
      } while (rerunRef.current);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  // Periodic save while the document is dirty.
  useEffect(() => {
    if (!enabled || !isDirty) return;
    const timer = setTimeout(() => void flush(), intervalMs);
    return () => clearTimeout(timer);
  }, [enabled, isDirty, snapshot, intervalMs, flush]);

  // Blur and tab-hide are the moments a writer is most likely to walk away.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onBlur = () => void flush();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (savedRef.current === JSON.stringify(valueRef.current)) return;
      void flush();
      // Browsers only honour this after a real interaction; harmless if not.
      event.preventDefault();
      event.returnValue = "";
    };

    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", onBlur);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flush]);

  // Soft navigation away from the editor.
  useEffect(() => () => void flush(), [flush]);

  return { state, isDirty, flush };
}
