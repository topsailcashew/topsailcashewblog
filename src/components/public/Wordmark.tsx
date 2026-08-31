"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { siteConfig } from "@/lib/site";

/**
 * The masthead (Design.md §8).
 *
 * This is the *only* place the display face appears. Titles elsewhere — cards,
 * posts, page heads, prose headings — are the serif, so a post's title looks
 * the same in the grid as it does on its own page.
 *
 * Condensation is the typeface's own (Anton), not letter-spacing — §4 is
 * explicit that faking it is not acceptable.
 */

/**
 * The hero sets the name as one unbroken wordmark — "TOPSAILCASHEW", the way
 * Design.md writes it — so it can be sized to fill the column on a single
 * line. The nav keeps the spaced form, which reads better at chrome scale.
 */
function heroWordmark(): string {
  return siteConfig.name.replace(/\s+/g, "");
}

export function Wordmark({
  as: Tag = "h1",
  className,
}: {
  as?: "h1" | "p" | "span";
  className?: string;
}) {
  const text = heroWordmark();
  const root = useRef<HTMLHeadingElement>(null);
  const frame = useRef<number | null>(null);
  const [lit, setLit] = useState(false);

  /*
    The accent copy is masked to a circle centred on the cursor, so the letters
    the pointer is over read orange and the rest stays black. Only the mask
    centre changes, which is a paint on one composited layer rather than a
    layout — cheap enough to run on every pointer move once rAF-coalesced.
  */
  const move = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Touch and pen would light the mark up and leave it lit; this is a
    // pointer affordance, so it is for pointers.
    if (event.pointerType !== "mouse") return;

    const element = root.current;
    if (!element) return;

    const { clientX, clientY } = event;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const box = element.getBoundingClientRect();
      element.style.setProperty("--mx", `${clientX - box.left}px`);
      element.style.setProperty("--my", `${clientY - box.top}px`);
    });
    setLit(true);
  }, []);

  const leave = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    setLit(false);
  }, []);

  // A pending frame after unmount would touch a detached node.
  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return (
    <Tag
      ref={root as React.Ref<HTMLHeadingElement>}
      className={["wordmark--hero", className].filter(Boolean).join(" ")}
      data-lit={lit ? "on" : undefined}
      /*
        The word is on the page twice, so the heading is named explicitly
        rather than from its contents. aria-hidden on the duplicate alone was
        not enough — the name computed to "topsailcashewtopsailcashew", which
        is what a screen reader would have read out. The label is the same
        string that is visible, so voice control still matches it.
      */
      aria-label={text}
      onPointerMove={move}
      onPointerLeave={leave}
    >
      <span className="wordmark-face" aria-hidden="true">
        {text}
      </span>
      {/*
        A second copy of the same word, painted in the accent and revealed
        through the mask. Without JavaScript --mx/--my are never set, the layer
        stays at zero opacity, and what remains is the plain black wordmark.
      */}
      <span className="wordmark-face wordmark-face--lit" aria-hidden="true">
        {text}
      </span>
    </Tag>
  );
}
