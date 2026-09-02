/**
 * Markdown to a Tiptap document.
 *
 * The target is not "Markdown" in general — it is exactly the node set
 * `src/components/editor/extensions.ts` defines (StarterKit with headings 1–3,
 * plus Image). Anything the editor cannot represent has to become something it
 * can, or be dropped, because `content_json` that does not round-trip through
 * the editor is corruption that only shows up the next time the post is opened.
 *
 * Written against what Google Docs actually exports, which is a narrow and
 * fairly tidy subset: ATX headings, `*` and `1.` lists with two-space
 * indentation for nesting, `**bold**`, `*italic*`, inline links, and
 * reference-style image definitions collected at the end of the file.
 */

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

export type ParsedDocument = {
  title: string | null;
  excerpt: string | null;
  tags: string[];
  doc: TiptapNode;
};

const MAX_HEADING_LEVEL = 3;

/**
 * Front matter, when the file opens with one.
 *
 * A plain `key: value` reader rather than a YAML parser — a YAML dependency
 * for three optional fields is not a trade worth making, and anything more
 * elaborate than this belongs in the editor, not in a text file.
 */
function splitFrontMatter(source: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    meta[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: source.slice(match[0].length) };
}

/** Reference definitions (`[id]: https://…`), which Docs uses for images. */
function collectReferences(lines: string[]): {
  refs: Map<string, string>;
  kept: string[];
} {
  const refs = new Map<string, string>();
  const kept: string[] = [];
  for (const line of lines) {
    const match = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/.exec(line);
    if (match) {
      refs.set(match[1].toLowerCase(), match[2]);
      continue;
    }
    kept.push(line);
  }
  return { refs, kept };
}

export function markdownToTiptap(
  source: string,
  fallbackTitle?: string,
): ParsedDocument {
  const { meta, body } = splitFrontMatter(source.replace(/\r\n/g, "\n"));
  const { refs, kept } = collectReferences(body.split("\n"));

  const blocks = parseBlocks(kept, refs);

  /*
    Title precedence: front matter, then a leading H1 (which is lifted out of
    the body so it is not repeated above the post's own title), then the file
    name. A document with none of those is still importable — the caller
    supplies "Untitled".
  */
  let title: string | null = meta.title ?? null;
  if (!title && blocks[0]?.type === "heading" && blocks[0].attrs?.level === 1) {
    const heading = plainText(blocks[0]).trim();
    if (heading !== "") {
      title = heading;
      blocks.shift();
    }
  }
  if (!title && fallbackTitle) title = fallbackTitle;

  const excerpt =
    meta.excerpt ??
    meta.description ??
    firstParagraphSummary(blocks) ??
    null;

  const tags = (meta.tags ?? meta.keywords ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 25);

  return {
    title,
    excerpt,
    tags,
    doc: {
      type: "doc",
      // The editor cannot hold an empty document; an empty paragraph is its
      // resting state (see EMPTY_DOC).
      content: blocks.length > 0 ? blocks : [{ type: "paragraph" }],
    },
  };
}

/* --- block level ---------------------------------------------------------- */

function parseBlocks(lines: string[], refs: Map<string, string>): TiptapNode[] {
  const blocks: TiptapNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    // Fenced code. Everything inside is literal, including things that would
    // otherwise look like headings or lists.
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const [, marker, language] = fence;
      const collected: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])
      ) {
        collected.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      blocks.push({
        type: "codeBlock",
        attrs: { language: language || null },
        content: collected.length ? [{ type: "text", text: collected.join("\n") }] : [],
      });
      continue;
    }

    const rule = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.exec(line);
    if (rule) {
      blocks.push({ type: "horizontalRule" });
      index += 1;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // The editor offers H1–H3 only; anything deeper is clamped rather than
      // dropped, so the text survives even if the level does not.
      const level = Math.min(heading[1].length, MAX_HEADING_LEVEL);
      blocks.push({
        type: "heading",
        attrs: { level },
        content: parseInline(heading[2].trim(), refs).inline,
      });
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", content: parseBlocks(quoted, refs) });
      continue;
    }

    if (listMarker(line)) {
      const consumed = parseList(lines, index, refs);
      blocks.push(consumed.node);
      index = consumed.next;
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !listMarker(lines[index]) &&
      !/^\s{0,3}(#{1,6}\s|>|`{3,}|~{3,})/.test(lines[index]) &&
      !/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(...paragraphBlocks(paragraph.join("\n"), refs));
  }

  return blocks;
}

type ListMarker = { ordered: boolean; indent: number; content: string };

function listMarker(line: string): ListMarker | null {
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) {
    return { ordered: false, indent: bullet[1].length, content: bullet[2] };
  }
  const ordered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
  if (ordered) {
    return { ordered: true, indent: ordered[1].length, content: ordered[2] };
  }
  return null;
}

/**
 * A list and any lists nested inside it.
 *
 * Nesting is by indentation, which is how Docs exports an outline. Losing it
 * would flatten a structured draft into an undifferentiated run of bullets.
 */
function parseList(
  lines: string[],
  start: number,
  refs: Map<string, string>,
): { node: TiptapNode; next: number } {
  const first = listMarker(lines[start])!;
  const baseIndent = first.indent;
  const items: TiptapNode[] = [];
  let index = start;

  while (index < lines.length) {
    const marker = listMarker(lines[index]);

    if (!marker) {
      // A blank line is allowed inside a list if the list continues after it.
      if (lines[index].trim() === "" && listMarker(lines[index + 1] ?? "")) {
        index += 1;
        continue;
      }
      break;
    }
    if (marker.indent < baseIndent) break;
    if (marker.ordered !== first.ordered && marker.indent === baseIndent) break;

    if (marker.indent > baseIndent) {
      const nested = parseList(lines, index, refs);
      // A nested list belongs inside the item above it.
      const parent = items[items.length - 1];
      if (parent) parent.content = [...(parent.content ?? []), nested.node];
      else items.push({ type: "listItem", content: [nested.node] });
      index = nested.next;
      continue;
    }

    items.push({
      type: "listItem",
      content: paragraphBlocks(marker.content, refs),
    });
    index += 1;
  }

  return {
    node: {
      type: first.ordered ? "orderedList" : "bulletList",
      ...(first.ordered ? { attrs: { start: 1 } } : {}),
      content: items,
    },
    next: index,
  };
}

/**
 * A paragraph, plus any images lifted out of it.
 *
 * The Image extension is configured `inline: false`, so an image cannot sit
 * inside a paragraph — putting one there would produce JSON the editor
 * rejects. Images become sibling blocks in the order they appeared.
 */
function paragraphBlocks(text: string, refs: Map<string, string>): TiptapNode[] {
  if (text.trim() === "") return [];
  const { inline, images } = parseInline(text, refs);

  const blocks: TiptapNode[] = [];
  if (inline.length > 0) blocks.push({ type: "paragraph", content: inline });
  for (const image of images) blocks.push(image);
  return blocks.length > 0 ? blocks : [{ type: "paragraph" }];
}

/* --- inline level --------------------------------------------------------- */

type Mark = { type: string; attrs?: Record<string, unknown> };

/**
 * Inline markup, in precedence order.
 *
 * Code spans are matched first and never recursed into: backticks suppress
 * everything else, so `**not bold**` inside a code span must stay literal.
 */
function parseInline(
  text: string,
  refs: Map<string, string>,
  marks: Mark[] = [],
): { inline: TiptapNode[]; images: TiptapNode[] } {
  const inline: TiptapNode[] = [];
  const images: TiptapNode[] = [];
  let rest = text;

  const push = (value: string) => {
    if (value === "") return;
    // A backslash escape means "this character is literal". The importers rely
    // on it: text extracted from a .docx is escaped on the way in, so an
    // asterisk someone typed does not come back as emphasis.
    value = unescapeMarkdown(value);
    // A hard break is two trailing spaces or a backslash before a newline;
    // any other newline inside a paragraph is just a wrap.
    const parts = value.split(/(?: {2,})\n/);
    parts.forEach((part, i) => {
      if (i > 0) inline.push({ type: "hardBreak" });
      const flattened = part.replace(/\n/g, " ");
      if (flattened !== "") {
        inline.push({
          type: "text",
          text: flattened,
          ...(marks.length > 0 ? { marks } : {}),
        });
      }
    });
  };

  while (rest.length > 0) {
    const match = nextToken(rest);
    if (!match) {
      push(rest);
      break;
    }

    push(rest.slice(0, match.index));

    if (match.kind === "code") {
      inline.push({
        type: "text",
        text: match.body,
        marks: [...marks, { type: "code" }],
      });
    } else if (match.kind === "image") {
      const src = resolveTarget(match.target, refs);
      // A reference with no definition would render as a broken image.
      if (src) images.push({ type: "image", attrs: { src, alt: match.body || null } });
    } else if (match.kind === "link") {
      const href = resolveTarget(match.target, refs);
      const nested = parseInline(
        match.body,
        refs,
        href ? [...marks, { type: "link", attrs: { href } }] : marks,
      );
      inline.push(...nested.inline);
      images.push(...nested.images);
    } else {
      const nested = parseInline(match.body, refs, [...marks, { type: match.kind }]);
      inline.push(...nested.inline);
      images.push(...nested.images);
    }

    rest = rest.slice(match.index + match.length);
  }

  return { inline, images };
}

type Token = {
  kind: "code" | "image" | "link" | "bold" | "italic" | "strike";
  index: number;
  length: number;
  body: string;
  target?: string;
};

/** The earliest inline token in `text`, or null when there is none. */
function nextToken(text: string): Token | null {
  /*
    Every delimiter is guarded with a negative lookbehind for a backslash, so
    an escaped `\*` is text rather than the start of emphasis.
  */
  const patterns: { kind: Token["kind"]; re: RegExp }[] = [
    { kind: "code", re: /(?<!\\)(`+)([\s\S]*?[^`]?)\1(?!`)/ },
    { kind: "strike", re: /(?<!\\)~~([\s\S]+?)~~/ },
    { kind: "bold", re: /(?<!\\)(\*\*|__)([\s\S]+?)\1/ },
    { kind: "italic", re: /(?<![*\w\\])([*_])(?!\s)([\s\S]+?)(?<!\s)\1(?![*\w])/ },
  ];

  let best: Token | null = findLinkOrImage(text);

  for (const { kind, re } of patterns) {
    const match = re.exec(text);
    if (!match) continue;
    if (best && match.index >= best.index) continue;

    if (kind === "code") {
      best = { kind, index: match.index, length: match[0].length, body: match[2].trim() };
    } else if (kind === "strike") {
      best = { kind, index: match.index, length: match[0].length, body: match[1] };
    } else {
      best = { kind, index: match.index, length: match[0].length, body: match[2] };
    }
  }
  return best;
}

/**
 * The earliest link or image, with its destination scanned rather than
 * matched.
 *
 * A regex cannot do this: a destination may itself contain balanced
 * parentheses — `[Foo](https://en.wikipedia.org/wiki/Foo_(bar))` is an
 * ordinary link — and a pattern that stops at the first `)` swallows part of
 * the URL and leaves the remainder as literal text in the middle of the
 * sentence.
 */
function findLinkOrImage(text: string): Token | null {
  const opener = /(?<!\\)(!?)\[((?:[^[\]\\]|\\.)*)\]/g;

  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const kind: Token["kind"] = match[1] === "!" ? "image" : "link";
    const after = match.index + match[0].length;

    if (text[after] === "(") {
      const close = matchingParen(text, after);
      if (close === -1) continue;
      // A destination may be followed by a "title" in quotes; take the URL.
      const inner = text.slice(after + 1, close).trim();
      const target = inner.split(/\s+/)[0] ?? "";
      return {
        kind,
        index: match.index,
        length: close + 1 - match.index,
        body: match[2],
        target,
      };
    }

    if (text[after] === "[") {
      const end = text.indexOf("]", after + 1);
      if (end === -1) continue;
      // `[text][]` and `[text][id]` both resolve; an empty id means the text.
      const reference = text.slice(after + 1, end) || match[2];
      return {
        kind,
        index: match.index,
        length: end + 1 - match.index,
        body: match[2],
        target: `ref:${reference}`,
      };
    }

    // A bracketed phrase with no destination is just text.
  }
  return null;
}

/** Index of the `)` closing the `(` at `open`, or -1 if unbalanced. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** An inline URL, or a reference id looked up in the definitions. */
function resolveTarget(
  target: string | undefined,
  refs: Map<string, string>,
): string | null {
  if (!target) return null;
  const url = target.startsWith("ref:")
    ? refs.get(target.slice(4).toLowerCase())
    : target;
  if (!url) return null;

  // The editor drops anything but http(s) and mailto; javascript: and data:
  // URLs must not survive an import either.
  return /^(https?:\/\/|mailto:|\/(?!\/))/i.test(url) ? url : null;
}

/* --- helpers -------------------------------------------------------------- */

/** Removes the backslashes that were protecting literal punctuation. */
function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*_[\]#>~()!-])/g, "$1");
}

export function plainText(node: TiptapNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(plainText).join("");
}

const EXCERPT_LIMIT = 200;

/** First paragraph, trimmed to a sentence boundary where there is one. */
function firstParagraphSummary(blocks: TiptapNode[]): string | null {
  const paragraph = blocks.find((block) => block.type === "paragraph");
  if (!paragraph) return null;

  const text = plainText(paragraph).replace(/\s+/g, " ").trim();
  if (text === "") return null;
  if (text.length <= EXCERPT_LIMIT) return text;

  const clipped = text.slice(0, EXCERPT_LIMIT);
  const lastStop = clipped.lastIndexOf(". ");
  return lastStop > EXCERPT_LIMIT / 2
    ? clipped.slice(0, lastStop + 1)
    : `${clipped.trimEnd()}…`;
}
