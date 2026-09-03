import { Extension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/react";
import { promptForLink } from "./link-prompt";
import { ProseHighlight } from "./prose-highlight";

/**
 * Fired on the editor's own DOM node when ⌘⌥I is pressed.
 *
 * A DOM event rather than a callback passed into the extension list. That
 * list is built exactly once — rebuilding it would recreate the ProseMirror
 * schema on every render — so a captured callback would be the one from the
 * first render forever. An event has no such lifetime problem, and it keeps
 * the schema definition free of any knowledge of the surrounding UI.
 */
export const INSERT_IMAGE_EVENT = "topsail:insert-image";

/**
 * One definition of the document schema.
 *
 * The editor and the HTML renderer must agree exactly — if they drift, saved
 * `content_json` renders differently from what was typed. StarterKit v3 already
 * bundles Link, so only Image and Placeholder are added on top.
 */
export function buildExtensions(placeholder = "Tell the story…"): Extensions {
  return [
    /*
      StarterKit binds the common marks already — ⌘B, ⌘I, ⌘E, ⌘⌥1-3,
      ⌘⇧7/8, ⌘⇧B, ⌘⌥C. These are the two it cannot: a link needs to ask for
      a URL, and an image needs a file picker.
    */
    Extension.create({
      name: "editorActions",
      addKeyboardShortcuts() {
        return {
          "Mod-k": () => {
            promptForLink(this.editor);
            return true;
          },
          // Not Mod-Shift-i: that is the browser's developer tools, and a
          // shortcut you have to fight the browser for is not a shortcut.
          "Mod-Alt-i": () => {
            this.editor.view.dom.dispatchEvent(new CustomEvent(INSERT_IMAGE_EVENT));
            return true;
          },
        };
      },
    }),
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
    /*
      Always present, dormant until switched on. It cannot be added
      conditionally: this list is built once inside a `useMemo`, and rebuilding
      it recreates the ProseMirror schema — which would reset the open
      document every time the writer ticked the box.
    */
    ProseHighlight,
  ];
}

/** An empty Tiptap document, for a post that has no content yet. */
export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
