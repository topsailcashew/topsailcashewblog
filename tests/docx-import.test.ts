import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { docxToMarkdown } from "@/lib/docx-to-markdown";
import { markdownToTiptap, plainText } from "@/lib/markdown-to-tiptap";
import { classify, parseGoogleShortcut } from "@/lib/prepare-documents";
import { readZip } from "@/lib/zip-reader";

/*
  DOMParser is a browser API and this code only ever runs in a browser, so the
  test supplies one. `fflate` writes the archives — deliberately a different
  implementation from the reader under test, so a shared bug cannot hide in
  both halves.
*/
globalThis.DOMParser = XmlDomParser as unknown as typeof DOMParser;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Assembles a .docx around some body XML. */
function makeDocx(
  bodyXml: string,
  extras: { rels?: string; numbering?: string } = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document ${W} ${R}><w:body>${bodyXml}</w:body></w:document>`,
    ),
  };
  if (extras.rels) files["word/_rels/document.xml.rels"] = strToU8(extras.rels);
  if (extras.numbering) files["word/numbering.xml"] = strToU8(extras.numbering);
  return zipSync(files);
}

const para = (runs: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${runs}</w:p>`;
const run = (text: string, props = "") =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

const md = async (bodyXml: string, extras = {}) =>
  (await docxToMarkdown(makeDocx(bodyXml, extras))).markdown;

describe("zip reader", () => {
  it("reads stored and deflated entries alike", async () => {
    // level 0 stores, level 9 deflates; both must come back identical.
    const body = "x".repeat(5000);
    for (const level of [0, 9] as const) {
      const archive = zipSync({ "a.txt": strToU8(body) }, { level });
      const entries = await readZip(archive);
      assert.equal(new TextDecoder().decode(entries.get("a.txt")!), body, `level ${level}`);
    }
  });

  it("keeps nested paths and skips directory entries", async () => {
    const archive = zipSync({
      "Essays/2026/note.md": strToU8("# Note"),
      "top.md": strToU8("# Top"),
    });
    const entries = await readZip(archive);
    assert.deepEqual([...entries.keys()].sort(), ["Essays/2026/note.md", "top.md"]);
  });

  it("refuses something that is not an archive", async () => {
    await assert.rejects(
      () => readZip(strToU8("just some text, definitely not a zip")),
      /does not look like a zip/,
    );
  });
});

describe("docx to markdown", () => {
  it("reads headings, clamping past the editor's three levels", async () => {
    const out = await md(
      para(run("Title Here"), "Title") +
        para(run("First"), "Heading1") +
        para(run("Second"), "Heading2") +
        para(run("Fourth"), "Heading4"),
    );
    assert.match(out, /^# Title Here$/m);
    assert.match(out, /^# First$/m);
    assert.match(out, /^## Second$/m);
    // Heading4 has no equivalent; it clamps rather than vanishing.
    assert.match(out, /^### Fourth$/m);
  });

  it("reads bold, italic and strikethrough", async () => {
    const out = await md(
      para(
        run("plain ") +
          run("bold", "<w:b/>") +
          run(" and ") +
          run("italic", "<w:i/>") +
          run(" and ") +
          run("gone", "<w:strike/>"),
      ),
    );
    assert.match(out, /\*\*bold\*\*/);
    assert.match(out, /\*italic\*/);
    assert.match(out, /~~gone~~/);
  });

  it("honours a toggle switched off by a run", async () => {
    // <w:b w:val="0"/> means "not bold here", usually undoing a style.
    const out = await md(para(run("not bold", '<w:b w:val="0"/>')));
    assert.equal(out.includes("**"), false);
  });

  it("keeps emphasis markers snug against the words", async () => {
    // "** bold **" is not emphasis in Markdown; the spaces must stay outside.
    const out = await md(para(run(" bold ", "<w:b/>")));
    assert.match(out, /\*\*bold\*\*/);
  });

  it("resolves a hyperlink through the relationships part", async () => {
    const out = await md(
      `<w:p><w:hyperlink r:id="rId7">${run("the note")}</w:hyperlink></w:p>`,
      {
        rels:
          `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a_(b)"/>` +
          `</Relationships>`,
      },
    );
    assert.match(out, /\[the note\]\(https:\/\/example\.com\/a_\(b\)\)/);
  });

  const numbering =
    `<?xml version="1.0"?><w:numbering ${W}>` +
    `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
    `</w:numbering>`;

  const listItem = (text: string, numId: string, level = 0) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;

  it("tells a bulleted list from a numbered one", async () => {
    const out = await md(listItem("bullet one", "1") + listItem("number one", "2"), {
      numbering,
    });
    assert.match(out, /^- bullet one$/m);
    assert.match(out, /^1\. number one$/m);
  });

  it("indents a nested list level", async () => {
    const out = await md(
      listItem("outer", "1") + listItem("inner", "1", 1),
      { numbering },
    );
    assert.match(out, /^- outer$/m);
    assert.match(out, /^ {2}- inner$/m);
  });

  it("escapes punctuation so Word's literal text stays literal", async () => {
    const out = await md(para(run("A 5 * 3 formula and a _name_ and [brackets]")));
    // Escaped on the way out...
    assert.match(out, /\\\*/);
    // ...and read back as the characters the writer typed.
    const parsed = markdownToTiptap(out);
    assert.equal(
      plainText(parsed.doc.content![0]),
      "A 5 * 3 formula and a _name_ and [brackets]",
    );
  });

  it("reports what it had to leave behind", async () => {
    const result = await docxToMarkdown(
      makeDocx(
        para(`<w:r><w:drawing/></w:r>`) +
          `<w:tbl><w:tr><w:tc>${para(run("cell"))}</w:tc></w:tr></w:tbl>`,
      ),
    );
    assert.equal(result.notes.length, 2);
    assert.ok(result.notes.some((n) => n.includes("image")));
    assert.ok(result.notes.some((n) => n.includes("table")));
  });

  it("survives a document that is only empty paragraphs", async () => {
    const result = await docxToMarkdown(makeDocx(para("") + para("") + para("")));
    assert.equal(result.markdown.trim(), "");
  });

  it("rejects a zip that is not a .docx", async () => {
    await assert.rejects(
      () => docxToMarkdown(zipSync({ "hello.txt": strToU8("hi") })),
      /no word\/document\.xml/,
    );
  });

  it("converts a whole document into the shape the editor expects", async () => {
    const out = await md(
      para(run("On Slow Software"), "Title") +
        para(run("There is a kind of ") + run("impatience", "<w:b/>") + run(" here.")) +
        para(run("What it costs"), "Heading1") +
        listItem("Rework, deferred", "1") +
        listItem("And repaid with interest", "1", 1) +
        para(run("Not slower. Differently paid for."), "Quote"),
      { numbering },
    );

    const parsed = markdownToTiptap(out);
    assert.equal(parsed.title, "On Slow Software");
    assert.deepEqual(parsed.doc.content?.map((b) => b.type), [
      "paragraph",
      "heading",
      "bulletList",
      "blockquote",
    ]);
    const list = parsed.doc.content![2];
    assert.ok(list.content![0].content!.some((n) => n.type === "bulletList"));
  });
});

describe("google drive shortcuts", () => {
  it("is recognised by extension", () => {
    assert.equal(classify("Essay.gdoc"), "gdoc");
    assert.equal(classify("Budget.gsheet"), "gdoc");
    assert.equal(classify("Notes.md"), "text");
    assert.equal(classify("Draft.docx"), "docx");
    assert.equal(classify("folder.zip"), "zip");
    assert.equal(classify("photo.jpg"), "other");
  });

  it("yields the document's own link so it can be opened and downloaded", () => {
    assert.equal(
      parseGoogleShortcut('{"url":"https://docs.google.com/open?id=1AbC","doc_id":"1AbC"}').url,
      "https://docs.google.com/open?id=1AbC",
    );
    // Some stubs carry only the id.
    assert.equal(
      parseGoogleShortcut('{"doc_id":"1AbC"}').url,
      "https://docs.google.com/document/d/1AbC/edit",
    );
    assert.deepEqual(parseGoogleShortcut("not json at all"), {});
  });
});
