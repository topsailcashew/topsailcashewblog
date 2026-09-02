import { docxToMarkdown } from "./docx-to-markdown";
import { readZip } from "./zip-reader";

/**
 * Works out what each dropped file is and gets Markdown out of it.
 *
 * Browser-side. Everything ends up as Markdown text, which the server then
 * reads with its one hardened parser — so this file cannot become a second,
 * unvalidated route to `content_html`.
 */

export type Prepared =
  /** Ready to send. */
  | { kind: "ready"; path: string; markdown: string; notes: string[] }
  /** Recognised, but nothing here can be read from it. */
  | { kind: "blocked"; path: string; reason: string; url?: string }
  /** Not a document. */
  | { kind: "ignored"; path: string; reason: string };

const TEXT_EXTENSIONS = [".md", ".markdown", ".txt"];

export function classify(path: string): "text" | "docx" | "gdoc" | "zip" | "other" {
  const lower = path.toLowerCase();
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "text";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".gdoc") || lower.endsWith(".gsheet") || lower.endsWith(".gslides")) {
    return "gdoc";
  }
  if (lower.endsWith(".zip")) return "zip";
  return "other";
}

/** What the writer is told they can drop. */
export const ACCEPTED_DESCRIPTION = ".docx, .md, .txt and .zip";

/**
 * A `.gdoc` is a shortcut, not a document.
 *
 * Google Drive for Desktop writes a couple of hundred bytes of JSON holding
 * the document's id — the text itself never leaves Google's servers. There is
 * nothing to extract locally, so the honest thing is to say so and point at
 * the download that does contain the words.
 */
export function parseGoogleShortcut(text: string): { url?: string } {
  try {
    const stub = JSON.parse(text) as { url?: string; doc_id?: string };
    if (stub.url) return { url: stub.url };
    if (stub.doc_id) {
      return { url: `https://docs.google.com/document/d/${stub.doc_id}/edit` };
    }
  } catch {
    // Not JSON; nothing useful to offer beyond the explanation.
  }
  return {};
}

const GDOC_REASON =
  "a Google Drive shortcut — it holds a link, not the text. " +
  "In Drive use File → Download → Microsoft Word (.docx), then drop that.";

export async function prepareFile(path: string, file: File): Promise<Prepared[]> {
  return prepare(path, () => file.arrayBuffer(), () => file.text());
}

async function prepare(
  path: string,
  bytes: () => Promise<ArrayBuffer>,
  text: () => Promise<string>,
): Promise<Prepared[]> {
  const kind = classify(path);

  try {
    if (kind === "text") {
      return [{ kind: "ready", path, markdown: await text(), notes: [] }];
    }

    if (kind === "docx") {
      const { markdown, notes } = await docxToMarkdown(new Uint8Array(await bytes()));
      return [{ kind: "ready", path, markdown, notes }];
    }

    if (kind === "gdoc") {
      const { url } = parseGoogleShortcut(await text());
      return [{ kind: "blocked", path, reason: GDOC_REASON, url }];
    }

    if (kind === "zip") {
      return await prepareZip(path, new Uint8Array(await bytes()));
    }

    return [{ kind: "ignored", path, reason: `not a document (${extensionOf(path)})` }];
  } catch (cause) {
    return [
      {
        kind: "blocked",
        path,
        reason: cause instanceof Error ? cause.message : "could not be read",
      },
    ];
  }
}

/**
 * A zip — which is what Drive gives you when you download more than one file
 * at a time — is expanded and its contents treated as if they had been
 * dropped directly.
 */
async function prepareZip(archivePath: string, bytes: Uint8Array): Promise<Prepared[]> {
  const entries = await readZip(bytes);
  const out: Prepared[] = [];
  const base = archivePath.replace(/\.zip$/i, "");

  for (const [name, content] of entries) {
    // Zip archives from macOS carry a metadata sidecar for every file.
    if (name.startsWith("__MACOSX/") || name.split("/").pop()?.startsWith("._")) {
      continue;
    }
    const inner = `${base}/${name}`;
    const kind = classify(name);
    if (kind === "zip") {
      out.push({ kind: "ignored", path: inner, reason: "a zip inside a zip" });
      continue;
    }
    out.push(
      ...(await prepare(
        inner,
        async () => toArrayBuffer(content),
        async () => new TextDecoder().decode(content),
      )),
    );
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "no extension";
}
