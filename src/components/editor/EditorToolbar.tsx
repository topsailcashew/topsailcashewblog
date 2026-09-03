"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { promptForLink } from "./link-prompt";

type Props = {
  editor: Editor;
  onPickImage: () => void;
  busy?: boolean;
};

type Item = {
  id: string;
  label: string;
  /** Shown in the tooltip and announced with the label. */
  shortcut?: string;
  content: ReactNode;
  active?: boolean;
  disabled?: boolean;
  run: () => void;
};

/**
 * A fixed toolbar rather than a slash menu: every available mark is visible
 * without having to know it exists, and it is trivially testable.
 *
 * ## Keyboard
 *
 * The toolbar is one tab stop, not thirteen. That is the ARIA toolbar pattern
 * — a roving tabindex, where exactly one button is in the tab order at a time
 * and the arrow keys move between them. Without it, a keyboard user tabbing
 * from the title field has to press Tab thirteen times to reach the text they
 * came here to write, every single time.
 *
 * Every button also names its shortcut, because the fastest path through this
 * toolbar is not to use it.
 */
export function EditorToolbar({ editor, onPickImage, busy }: Props) {
  // Shared with the ⌘K shortcut, so the button and the keystroke cannot drift.
  const setLink = useCallback(() => promptForLink(editor), [editor]);

  const groups: Item[][] = [
    [
      {
        id: "bold",
        label: "Bold",
        shortcut: `${MOD}+B`,
        content: <strong>B</strong>,
        active: editor.isActive("bold"),
        run: () => editor.chain().focus().toggleBold().run(),
      },
      {
        id: "italic",
        label: "Italic",
        shortcut: `${MOD}+I`,
        content: <em>I</em>,
        active: editor.isActive("italic"),
        run: () => editor.chain().focus().toggleItalic().run(),
      },
      {
        id: "code",
        label: "Inline code",
        shortcut: `${MOD}+E`,
        content: <code>{"<>"}</code>,
        active: editor.isActive("code"),
        run: () => editor.chain().focus().toggleCode().run(),
      },
    ],
    ([1, 2, 3] as const).map((level) => ({
      id: `h${level}`,
      label: `Heading ${level}`,
      shortcut: `${MOD}+Alt+${level}`,
      content: `H${level}`,
      active: editor.isActive("heading", { level }),
      run: () => editor.chain().focus().toggleHeading({ level }).run(),
    })),
    [
      {
        id: "bullet",
        label: "Bullet list",
        shortcut: `${MOD}+Shift+8`,
        content: "• List",
        active: editor.isActive("bulletList"),
        run: () => editor.chain().focus().toggleBulletList().run(),
      },
      {
        id: "ordered",
        label: "Numbered list",
        shortcut: `${MOD}+Shift+7`,
        content: "1. List",
        active: editor.isActive("orderedList"),
        run: () => editor.chain().focus().toggleOrderedList().run(),
      },
      {
        id: "quote",
        label: "Blockquote",
        shortcut: `${MOD}+Shift+B`,
        content: "“",
        active: editor.isActive("blockquote"),
        run: () => editor.chain().focus().toggleBlockquote().run(),
      },
      {
        id: "codeblock",
        label: "Code block",
        shortcut: `${MOD}+Alt+C`,
        content: "Code",
        active: editor.isActive("codeBlock"),
        run: () => editor.chain().focus().toggleCodeBlock().run(),
      },
    ],
    [
      {
        id: "link",
        label: "Link",
        shortcut: `${MOD}+K`,
        content: "Link",
        active: editor.isActive("link"),
        run: setLink,
      },
      {
        id: "image",
        label: "Insert image",
        shortcut: `${MOD}+Alt+I`,
        content: busy ? "Uploading…" : "Image",
        disabled: busy,
        run: onPickImage,
      },
    ],
  ];

  return <Toolbar groups={groups} />;
}

function Toolbar({ groups }: { groups: Item[][] }) {
  const items = groups.flat();
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  /**
   * Which button holds the toolbar's single tab stop.
   *
   * Held by id rather than index so a button appearing or disappearing does
   * not silently move the tab stop to a different control.
   */
  const [focusedId, setFocusedId] = useState(items[0]?.id);
  const focusedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === focusedId),
  );

  function moveTo(index: number): void {
    // Wraps at both ends: arrowing right off the last button returns to the
    // first, which is what the ARIA pattern specifies and what anyone who has
    // used a toolbar expects.
    const next = items[(index + items.length) % items.length];
    if (!next) return;
    setFocusedId(next.id);
    buttonRefs.current.get(next.id)?.focus();
  }

  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      onKeyDown={(event) => {
        switch (event.key) {
          case "ArrowRight":
            event.preventDefault();
            moveTo(focusedIndex + 1);
            break;
          case "ArrowLeft":
            event.preventDefault();
            moveTo(focusedIndex - 1);
            break;
          case "Home":
            event.preventDefault();
            moveTo(0);
            break;
          case "End":
            event.preventDefault();
            moveTo(items.length - 1);
            break;
          default:
            break;
        }
      }}
    >
      {groups.map((group, index) => (
        <div className="toolbar-group" key={group[0]?.id ?? index}>
          {group.map((item) => (
            <button
              key={item.id}
              ref={(element) => {
                if (element) buttonRefs.current.set(item.id, element);
                else buttonRefs.current.delete(item.id);
              }}
              type="button"
              title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
              // The shortcut rides along in the accessible name, so a screen
              // reader user learns it the same way a sighted one learns it
              // from the tooltip.
              aria-label={item.shortcut ? `${item.label}, ${item.shortcut}` : item.label}
              aria-pressed={item.active ?? false}
              disabled={item.disabled}
              // The roving tabindex: one 0, the rest -1.
              tabIndex={item.id === focusedId ? 0 : -1}
              className={item.active ? "toolbar-button is-active" : "toolbar-button"}
              // Clicking a button must not steal the selection it acts on.
              onMouseDown={(event) => event.preventDefault()}
              onFocus={() => setFocusedId(item.id)}
              onClick={item.run}
            >
              {item.content}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The modifier key's name on this platform.
 *
 * Printing "Ctrl+B" to someone on a Mac is worse than printing nothing —
 * it is a shortcut that does not exist.
 */
const MOD =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "")
    ? "⌘"
    : "Ctrl";
