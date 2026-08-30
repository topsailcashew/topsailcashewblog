import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/react";

/**
 * One definition of the document schema.
 *
 * The editor and the HTML renderer must agree exactly — if they drift, saved
 * `content_json` renders differently from what was typed. StarterKit v3 already
 * bundles Link, so only Image and Placeholder are added on top.
 */
export function buildExtensions(placeholder = "Tell the story…"): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        // Anything else (javascript:, data:) is silently dropped.
        protocols: ["http", "https", "mailto"],
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      },
    }),
    Image.configure({
      inline: false,
      // Images live in R2 and are referenced by URL; inlining base64 would
      // bloat content_json and bypass the upload path entirely.
      allowBase64: false,
      HTMLAttributes: { loading: "lazy" },
    }),
    Placeholder.configure({ placeholder }),
  ];
}

/** An empty Tiptap document, for a post that has no content yet. */
export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
