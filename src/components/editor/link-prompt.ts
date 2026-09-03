import type { Editor } from "@tiptap/react";

/**
 * Sets or clears a link on the current selection.
 *
 * Lives on its own because two things need it: the toolbar button and the
 * ⌘K shortcut. Having the shortcut re-implement the prompt is how the two
 * quietly come to behave differently — one extending the mark range, the
 * other not.
 */
export function promptForLink(editor: Editor): void {
  const previous = editor.getAttributes("link").href as string | undefined;
  const input = window.prompt("Link URL (empty to remove)", previous ?? "https://");
  if (input === null) return;

  if (input.trim() === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  // extendMarkRange so editing an existing link replaces the whole thing
  // rather than splitting it at the cursor.
  editor.chain().focus().extendMarkRange("link").setLink({ href: input.trim() }).run();
}
