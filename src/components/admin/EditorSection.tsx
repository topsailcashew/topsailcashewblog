"use client";

import type { ReactNode } from "react";

/**
 * One collapsible block in the editor sidebar.
 *
 * Built on `<details>` rather than a button plus state: the open/closed
 * behaviour, the keyboard handling and the disclosure semantics all come for
 * free, and every section then behaves the same way. Before this, publication
 * was always-open, SEO had its own toggle button and history had another —
 * three different affordances for the same idea.
 */
export function EditorSection({
  title,
  summary,
  defaultOpen = false,
  onOpen,
  children,
}: {
  title: string;
  /** A word or two of state, shown on the closed header. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Fired the first time the section is expanded, for load-on-demand. */
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    <details
      className="editor-section"
      open={defaultOpen}
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen?.();
      }}
    >
      <summary className="editor-section-head">
        <span className="editor-section-title">{title}</span>
        {summary !== undefined && summary !== null && (
          <span className="editor-section-summary">{summary}</span>
        )}
      </summary>
      <div className="editor-section-body">{children}</div>
    </details>
  );
}
