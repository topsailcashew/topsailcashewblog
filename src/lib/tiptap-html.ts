/**
 * Tiptap JSON back to HTML.
 *
 * Only `content_json` is snapshotted — `content_html` is derived from it, and
 * storing both would double the size of every revision row for no new
 * information. This walks the same node set the editor's schema admits
 * (see src/components/editor/extensions.ts); anything unrecognised is dropped
 * rather than passed through, so a restore can never introduce markup the
 * editor could not have produced.
 */
export function renderTiptapHtml(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  return renderNodes((doc as { content?: unknown[] }).content ?? []);
}

function renderNodes(nodes: unknown[]): string {
  return nodes.map(renderNode).join("");
}

function renderNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const { type, attrs, content, text, marks } = node as {
    type?: string;
    attrs?: Record<string, unknown>;
    content?: unknown[];
    text?: string;
    marks?: { type?: string; attrs?: Record<string, unknown> }[];
  };

  if (type === "text") return applyMarks(escapeHtml(text ?? ""), marks ?? []);

  const inner = renderNodes(content ?? []);
  switch (type) {
    case "paragraph":
      return `<p>${inner}</p>`;
    case "heading": {
      const level = Math.min(Math.max(Number(attrs?.level) || 2, 1), 6);
      return `<h${level}>${inner}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${inner}</ul>`;
    case "orderedList":
      return `<ol>${inner}</ol>`;
    case "listItem":
      return `<li>${inner}</li>`;
    case "blockquote":
      return `<blockquote>${inner}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${inner}</code></pre>`;
    case "horizontalRule":
      return "<hr>";
    case "hardBreak":
      return "<br>";
    case "image": {
      const src = String(attrs?.src ?? "");
      if (!isSafeImageSrc(src)) return "";
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(String(attrs?.alt ?? ""))}">`;
    }
    default:
      return inner;
  }
}

function applyMarks(
  html: string,
  marks: { type?: string; attrs?: Record<string, unknown> }[],
): string {
  return marks.reduce((acc, mark) => {
    switch (mark.type) {
      case "bold":
        return `<strong>${acc}</strong>`;
      case "italic":
        return `<em>${acc}</em>`;
      case "strike":
        return `<s>${acc}</s>`;
      case "code":
        return `<code>${acc}</code>`;
      case "link": {
        const href = String(mark.attrs?.href ?? "");
        // Anything but http(s) or a site-relative path is dropped, which rules
        // out javascript: and data: URLs.
        if (!/^https?:\/\//.test(href) && !/^\/(?!\/)/.test(href)) return acc;
        return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${acc}</a>`;
      }
      default:
        return acc;
    }
  }, html);
}

function isSafeImageSrc(src: string): boolean {
  return /^https?:\/\//.test(src) || /^\/(?!\/)/.test(src);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
