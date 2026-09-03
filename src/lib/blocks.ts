/**
 * A post as an ordered list of typed blocks.
 *
 * ## What this is for
 *
 * The database already stores structured content: `posts.content_json` is the
 * Tiptap document and has been the source of truth since the editor landed —
 * `content_html` is a derived cache, rebuilt from the JSON on every save, and
 * revisions store only the JSON for exactly that reason.
 *
 * But ProseMirror's JSON is an *editor* schema, not a publishing one. It nests
 * a paragraph inside every list item, expresses bold as an entry in a `marks`
 * array attached to a text node, and is free to change shape when Tiptap does.
 * Handing that to a mobile client means the client now depends on the internals
 * of this blog's editor.
 *
 * So this is the seam: a flat, named, versioned block list that a native app,
 * a static generator or another site can render without knowing anything about
 * ProseMirror. Formatting travels as character ranges rather than nesting,
 * because every UI toolkit worth using — AttributedString, Spannable,
 * TextSpan — already works that way, and none of them parse HTML.
 */

export const BLOCK_FORMAT_VERSION = 1;

/** A run of formatting over `text`, by character offset. Ranges may overlap. */
export type Span = {
  start: number;
  /** Exclusive. */
  end: number;
  type: "bold" | "italic" | "strike" | "code" | "link";
  /** Present only on links. */
  href?: string;
};

export type RichText = { text: string; spans: Span[] };

export type Block =
  | ({ type: "paragraph"; id: string } & RichText)
  | ({ type: "heading"; id: string; level: 1 | 2 | 3 } & RichText)
  | { type: "list"; id: string; ordered: boolean; items: RichText[] }
  | ({ type: "quote"; id: string } & RichText)
  | { type: "code"; id: string; language: string | null; code: string }
  | {
      type: "image";
      id: string;
      src: string;
      /** Empty string means decorative — the reader should skip it. */
      alt: string;
    }
  | { type: "divider"; id: string };

type Node = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
};

/**
 * Converts a stored Tiptap document into blocks.
 *
 * Unknown node types are flattened to their children rather than dropped: if
 * the editor gains a node this does not know about, a consumer should still
 * receive the words inside it rather than a hole in the article.
 */
export function toBlocks(doc: unknown): Block[] {
  if (!doc || typeof doc !== "object") return [];
  const nodes = (doc as { content?: Node[] }).content ?? [];

  const blocks: Block[] = [];
  for (const node of nodes) collect(node, blocks);
  return blocks;
}

function collect(node: Node, blocks: Block[]): void {
  const id = `b${blocks.length + 1}`;

  switch (node.type) {
    case "paragraph": {
      const rich = toRichText(node.content ?? []);
      // An empty paragraph is the editor's way of holding a cursor position.
      // It is not content, and it renders as a stray gap in anything that
      // takes this list literally.
      if (rich.text.trim() === "") return;
      blocks.push({ type: "paragraph", id, ...rich });
      return;
    }
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 2, 1), 3) as 1 | 2 | 3;
      blocks.push({ type: "heading", id, level, ...toRichText(node.content ?? []) });
      return;
    }
    case "bulletList":
    case "orderedList": {
      const items = (node.content ?? [])
        .map((item) => toRichText(flattenInline(item)))
        .filter((item) => item.text.trim() !== "");
      if (items.length === 0) return;
      blocks.push({ type: "list", id, ordered: node.type === "orderedList", items });
      return;
    }
    case "blockquote": {
      // Flattened to one block. A quote containing three paragraphs is still
      // one quotation, and nesting blocks inside blocks is the complication
      // this format exists to avoid.
      blocks.push({ type: "quote", id, ...toRichText(flattenInline(node)) });
      return;
    }
    case "codeBlock": {
      blocks.push({
        type: "code",
        id,
        language: typeof node.attrs?.language === "string" ? node.attrs.language : null,
        code: plainText(node.content ?? []),
      });
      return;
    }
    case "image": {
      const src = String(node.attrs?.src ?? "");
      if (src === "") return;
      blocks.push({ type: "image", id, src, alt: String(node.attrs?.alt ?? "") });
      return;
    }
    case "horizontalRule":
      blocks.push({ type: "divider", id });
      return;
    default:
      for (const child of node.content ?? []) collect(child, blocks);
  }
}

/** Every inline node beneath a block, in order, ignoring paragraph nesting. */
function flattenInline(node: Node): Node[] {
  const out: Node[] = [];
  const walk = (current: Node) => {
    if (current.type === "text") {
      out.push(current);
      return;
    }
    if (current.type === "hardBreak") {
      out.push({ type: "text", text: "\n" });
      return;
    }
    for (const child of current.content ?? []) walk(child);
  };
  for (const child of node.content ?? []) walk(child);
  return out;
}

/**
 * Text plus the formatting over it, as offsets.
 *
 * Offsets are in UTF-16 code units, which is what `String.prototype.slice`,
 * Swift's `NSAttributedString` and Android's `Spannable` all count in.
 * Adjacent runs of the same mark are merged, so "**bo**​**ld**" — two text
 * nodes the editor happened to split — arrives as one span rather than two
 * touching ones a renderer would have to join.
 */
export function toRichText(nodes: Node[]): RichText {
  let text = "";
  const spans: Span[] = [];

  for (const node of nodes) {
    if (node.type === "hardBreak") {
      text += "\n";
      continue;
    }
    const value = node.text ?? "";
    if (value === "") continue;

    const start = text.length;
    text += value;
    const end = text.length;

    for (const mark of node.marks ?? []) {
      const type = markType(mark.type);
      if (!type) continue;

      const href = type === "link" ? safeHref(mark.attrs?.href) : undefined;
      if (type === "link" && !href) continue;

      const previous = spans[spans.length - 1];
      if (previous && previous.type === type && previous.end === start && previous.href === href) {
        previous.end = end;
      } else {
        spans.push({ start, end, type, ...(href ? { href } : {}) });
      }
    }
  }

  return { text, spans };
}

function markType(type: string | undefined): Span["type"] | null {
  switch (type) {
    case "bold":
    case "italic":
    case "strike":
    case "code":
    case "link":
      return type;
    default:
      return null;
  }
}

/**
 * The same restriction the HTML renderer applies: http(s) or site-relative.
 *
 * Syndicated content ends up in clients that will happily follow whatever is
 * in an `href`, and a `javascript:` URL surviving into a native app's web view
 * is the same hole it would be here.
 */
function safeHref(value: unknown): string | undefined {
  const href = typeof value === "string" ? value : "";
  if (/^https?:\/\//.test(href) || /^\/(?!\/)/.test(href)) return href;
  return undefined;
}

function plainText(nodes: Node[]): string {
  return nodes.map((node) => node.text ?? plainText(node.content ?? [])).join("");
}
