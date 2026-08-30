"use client";

import dynamic from "next/dynamic";
import type { SerializedPost } from "@/lib/posts";
import type { SerializedSeries } from "@/lib/series";

/**
 * Loads the editor on the client only.
 *
 * Tiptap and ProseMirror are a large dependency, and the editor is never
 * rendered on the server (`immediatelyRender: false`). Importing it lazily
 * keeps roughly half a megabyte of editor code out of the Worker bundle, which
 * matters against Cloudflare's compressed size limit.
 */
const PostEditor = dynamic(
  () => import("./PostEditor").then((module) => module.PostEditor),
  {
    ssr: false,
    loading: () => <p className="muted">Loading the editor…</p>,
  },
);

export function PostEditorLoader({
  initialPost,
  series,
}: {
  initialPost: SerializedPost | null;
  series: SerializedSeries[];
}) {
  return <PostEditor initialPost={initialPost} series={series} />;
}
