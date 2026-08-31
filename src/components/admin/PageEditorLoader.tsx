"use client";

import dynamic from "next/dynamic";
import type { SerializedPage } from "@/lib/pages";

/** Client-only for the same reason as PostEditorLoader — Tiptap is large. */
const PageEditor = dynamic(
  () => import("./PageEditor").then((module) => module.PageEditor),
  {
    ssr: false,
    loading: () => <p className="muted">Loading the editor…</p>,
  },
);

export function PageEditorLoader({ initialPage }: { initialPage: SerializedPage | null }) {
  return <PageEditor initialPage={initialPage} />;
}
