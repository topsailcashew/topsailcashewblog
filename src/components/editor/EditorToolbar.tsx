"use client";

import type { Editor } from "@tiptap/react";
import { useCallback } from "react";

type Props = {
  editor: Editor;
  onPickImage: () => void;
  busy?: boolean;
};

/**
 * A fixed toolbar rather than a slash menu: every available mark is visible
 * without having to know it exists, and it is trivially testable. Keyboard
 * shortcuts from StarterKit still work alongside it.
 */
export function EditorToolbar({ editor, onPickImage, busy }: Props) {
  const setLink = useCallback(() => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const input = window.prompt("Link URL (empty to remove)", previous ?? "https://");

    if (input === null) return;
    if (input.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: input.trim() })
      .run();
  }, [editor]);

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Group>
        <Button
          label="Bold"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </Button>
        <Button
          label="Italic"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </Button>
        <Button
          label="Inline code"
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <code>{"<>"}</code>
        </Button>
      </Group>

      <Group>
        {([1, 2, 3] as const).map((level) => (
          <Button
            key={level}
            label={`Heading ${level}`}
            active={editor.isActive("heading", { level })}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
          >
            H{level}
          </Button>
        ))}
      </Group>

      <Group>
        <Button
          label="Bullet list"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          • List
        </Button>
        <Button
          label="Numbered list"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          1. List
        </Button>
        <Button
          label="Blockquote"
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          &ldquo;
        </Button>
        <Button
          label="Code block"
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          Code
        </Button>
      </Group>

      <Group>
        <Button label="Link" active={editor.isActive("link")} onClick={setLink}>
          Link
        </Button>
        <Button label="Insert image" onClick={onPickImage} disabled={busy}>
          {busy ? "Uploading…" : "Image"}
        </Button>
      </Group>
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="toolbar-group">{children}</div>;
}

function Button({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active ?? false}
      disabled={disabled}
      className={active ? "toolbar-button is-active" : "toolbar-button"}
      // Keeps the selection while the button takes focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
