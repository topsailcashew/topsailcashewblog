import { entryText, readZip } from "./zip-reader";

/**
 * Word/Google Docs `.docx` to Markdown.
 *
 * Markdown rather than Tiptap JSON on purpose. The server already has a
 * tested, hardened Markdown reader (`markdown-to-tiptap.ts`) that clamps
 * headings, filters link schemes and refuses anything the editor cannot
 * represent. Emitting Markdown here means every imported document goes through
 * that same door, instead of this file becoming a second, unvalidated way to
 * write `content_json`.
 *
 * A `.docx` is a zip of XML. The parts that matter:
 *
 *   word/document.xml                 the text and its structure
 *   word/_rels/document.xml.rels      hyperlink targets, referenced by id
 *   word/numbering.xml                whether a list is bulleted or numbered
 */

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type DocxResult = {
  markdown: string;
  /** Things the editor has no equivalent for, reported rather than dropped silently. */
  notes: string[];
};

export async function docxToMarkdown(bytes: Uint8Array): Promise<DocxResult> {
  const entries = await readZip(bytes);

  const documentXml = entryText(entries, "word/document.xml");
  if (!documentXml) {
    throw new Error("That .docx has no word/document.xml — it may be corrupt");
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, "application/xml");
  // getElementsByTagName rather than querySelector: the browser reports a
  // malformed document by inserting this element, and the check has to work
  // in the lighter XML parser the tests use too.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Could not read the document XML inside that .docx");
  }

  const links = readRelationships(parser, entryText(entries, "word/_rels/document.xml.rels"));
  const ordered = readNumbering(parser, entryText(entries, "word/numbering.xml"));

  const body = doc.getElementsByTagNameNS(W, "body")[0];
  if (!body) throw new Error("That .docx has no document body");

  const lines: string[] = [];
  const notes = new Set<string>();

  for (const child of Array.from(body.children)) {
    if (child.localName === "p") {
      renderParagraph(child, { links, ordered, lines, notes });
    } else if (child.localName === "tbl") {
      // The editor has no table node; flattening one into paragraphs would
      // scramble it, so it is left out and said so.
      notes.add("a table was left out — the editor has no table support");
    }
  }

  return { markdown: tidy(lines), notes: [...notes] };
}

type Context = {
  links: Map<string, string>;
  ordered: Map<string, boolean>;
  lines: string[];
  notes: Set<string>;
};

function renderParagraph(paragraph: Element, context: Context): void {
  const properties = child(paragraph, "pPr");
  const styleId = properties ? attr(child(properties, "pStyle"), "val") ?? "" : "";
  const text = renderRuns(paragraph, context);

  if (text.trim() === "") {
    // A run of empty paragraphs is Word's way of spacing; one blank is enough.
    if (context.lines.at(-1) !== "") context.lines.push("");
    return;
  }

  const numbering = properties ? child(properties, "numPr") : null;
  if (numbering) {
    const level = Number(attr(child(numbering, "ilvl"), "val") ?? "0");
    const numId = attr(child(numbering, "numId"), "val") ?? "";
    const indent = "  ".repeat(Math.min(level, 4));
    const marker = context.ordered.get(numId) ? "1." : "-";
    context.lines.push(`${indent}${marker} ${text}`);
    return;
  }

  const heading = /^Heading([1-9])$/i.exec(styleId);
  if (heading) {
    const level = Math.min(Number(heading[1]), 3);
    blank(context.lines);
    context.lines.push(`${"#".repeat(level)} ${text}`);
    context.lines.push("");
    return;
  }
  if (/^Title$/i.test(styleId)) {
    blank(context.lines);
    context.lines.push(`# ${text}`);
    context.lines.push("");
    return;
  }
  if (/quote/i.test(styleId)) {
    blank(context.lines);
    context.lines.push(`> ${text}`);
    context.lines.push("");
    return;
  }

  blank(context.lines);
  context.lines.push(text);
  context.lines.push("");
}

/** The runs of one paragraph, with their formatting, as inline Markdown. */
function renderRuns(paragraph: Element, context: Context): string {
  let out = "";

  for (const node of Array.from(paragraph.children)) {
    if (node.localName === "hyperlink") {
      const id = node.getAttributeNS(R, "id");
      const target = id ? context.links.get(id) : undefined;
      const inner = renderRuns(node, context);
      out += target && inner ? `[${inner}](${target})` : inner;
      continue;
    }
    if (node.localName !== "r") continue;

    const properties = child(node, "rPr");
    let piece = "";
    let sawContent = false;

    for (const part of Array.from(node.children)) {
      if (part.localName === "t") {
        piece += escapeMarkdown(part.textContent ?? "");
        sawContent = true;
      } else if (part.localName === "tab") {
        piece += " ";
      } else if (part.localName === "br") {
        // Two trailing spaces is Markdown's hard break.
        piece += "  \n";
      } else if (part.localName === "drawing" || part.localName === "pict") {
        context.notes.add(
          "an image was left out — add it in the editor, where it can be uploaded",
        );
      }
    }

    if (!sawContent) {
      out += piece;
      continue;
    }

    // Applied innermost first so the markers nest in a legible order.
    if (isOn(properties, "strike") || isOn(properties, "dstrike")) piece = wrap(piece, "~~");
    if (isOn(properties, "i")) piece = wrap(piece, "*");
    if (isOn(properties, "b")) piece = wrap(piece, "**");
    out += piece;
  }

  return out.replace(/[ \t]+$/gm, (match) => (match === "  " ? match : ""));
}

/**
 * Word writes a toggle property as `<w:b/>`, `<w:b w:val="true"/>` or
 * `<w:b w:val="0"/>` — the last meaning *off*, usually because a style turned
 * it on and this run turns it back off.
 */
function isOn(properties: Element | null, name: string): boolean {
  if (!properties) return false;
  const element = child(properties, name);
  if (!element) return false;
  const value = attr(element, "val");
  return value === null || !["0", "false", "off"].includes(value.toLowerCase());
}

/** Wraps non-empty content, keeping the surrounding spaces outside the marker. */
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || match[2] === "") return text;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function readRelationships(parser: DOMParser, xml: string | null): Map<string, string> {
  const links = new Map<string, string>();
  if (!xml) return links;

  const doc = parser.parseFromString(xml, "application/xml");
  for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
    const type = rel.getAttribute("Type") ?? "";
    if (!type.endsWith("/hyperlink")) continue;
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) links.set(id, target);
  }
  return links;
}

/**
 * Which numbering definitions are ordered.
 *
 * A `numId` points at an abstract definition that carries the format, so both
 * files have to be read to tell "1. 2. 3." from a bullet.
 */
function readNumbering(parser: DOMParser, xml: string | null): Map<string, boolean> {
  const ordered = new Map<string, boolean>();
  if (!xml) return ordered;

  const doc = parser.parseFromString(xml, "application/xml");

  const formats = new Map<string, boolean>();
  for (const abstract of Array.from(doc.getElementsByTagNameNS(W, "abstractNum"))) {
    const id = abstract.getAttributeNS(W, "abstractNumId");
    if (!id) continue;
    const first = abstract.getElementsByTagNameNS(W, "numFmt")[0];
    const format = first?.getAttributeNS(W, "val") ?? "bullet";
    formats.set(id, format !== "bullet" && format !== "none");
  }

  for (const num of Array.from(doc.getElementsByTagNameNS(W, "num"))) {
    const numId = num.getAttributeNS(W, "numId");
    const abstractId = num
      .getElementsByTagNameNS(W, "abstractNumId")[0]
      ?.getAttributeNS(W, "val");
    if (numId && abstractId) ordered.set(numId, formats.get(abstractId) ?? false);
  }
  return ordered;
}

/* --- helpers -------------------------------------------------------------- */

function child(parent: Element | null, name: string): Element | null {
  if (!parent) return null;
  for (const node of Array.from(parent.children)) {
    if (node.localName === name) return node;
  }
  return null;
}

function attr(element: Element | null, name: string): string | null {
  if (!element) return null;
  return element.getAttributeNS(W, name) ?? element.getAttribute(`w:${name}`);
}

function blank(lines: string[]): void {
  if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
}

/**
 * Escapes the characters that would otherwise be read as formatting.
 *
 * Word text is literal: a sentence containing an asterisk means an asterisk,
 * and passing it through unescaped would silently turn part of the document
 * into emphasis on the way back in.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]#>])/g, "\\$1");
}

function tidy(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
