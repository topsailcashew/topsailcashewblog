import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownToTiptap, plainText, type TiptapNode } from "@/lib/markdown-to-tiptap";

const doc = (md: string) => markdownToTiptap(md).doc.content ?? [];
const types = (md: string) => doc(md).map((b) => b.type);

/** Marks on the first text node inside a block, for terse assertions. */
function firstMarks(node: TiptapNode): string[] {
  if (node.type === "text") return (node.marks ?? []).map((m) => m.type);
  for (const child of node.content ?? []) {
    const found = firstMarks(child);
    if (found.length > 0) return found;
  }
  return [];
}

describe("markdown to tiptap", () => {
  describe("blocks", () => {
    it("splits paragraphs on blank lines and joins wrapped lines", () => {
      const blocks = doc("One line\nstill the same paragraph.\n\nA second one.");
      assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "paragraph"]);
      assert.equal(plainText(blocks[0]), "One line still the same paragraph.");
    });

    it("reads headings and clamps below the editor's three levels", () => {
      const blocks = doc("Intro.\n\n# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five");
      assert.deepEqual(
        blocks.slice(1).map((b) => b.attrs?.level),
        [1, 2, 3, 3, 3],
      );
      // Clamped, not dropped — the words survive even when the level cannot.
      assert.equal(plainText(blocks[5]), "Five");
    });

    it("reads bullet and ordered lists", () => {
      const bullets = doc("- one\n- two\n- three");
      assert.equal(bullets[0].type, "bulletList");
      assert.equal(bullets[0].content?.length, 3);
      assert.equal(plainText(bullets[0].content![1]), "two");

      const ordered = doc("1. first\n2. second");
      assert.equal(ordered[0].type, "orderedList");
      assert.equal(ordered[0].content?.length, 2);
    });

    it("keeps a nested list inside the item above it", () => {
      const blocks = doc("* Outer\n  * Inner one\n  * Inner two\n* Next outer");
      const list = blocks[0];
      assert.equal(list.type, "bulletList");
      assert.equal(list.content?.length, 2);

      // The nested list is a child of the first item, not a sibling.
      const nested = list.content![0].content!.find((n) => n.type === "bulletList");
      assert.ok(nested, "expected a nested list inside the first item");
      assert.equal(nested.content?.length, 2);
      assert.equal(plainText(nested.content![0]), "Inner one");
    });

    it("does not merge an ordered list into a bullet list at the same level", () => {
      assert.deepEqual(types("- a\n- b\n\n1. c\n2. d"), ["bulletList", "orderedList"]);
    });

    it("reads blockquotes, including multiple paragraphs", () => {
      const blocks = doc("> First.\n>\n> Second.");
      assert.equal(blocks[0].type, "blockquote");
      assert.deepEqual(blocks[0].content?.map((b) => b.type), ["paragraph", "paragraph"]);
    });

    it("reads fenced code and leaves its contents literal", () => {
      const blocks = doc("```ts\nconst x = `**not bold**`;\n# not a heading\n```");
      assert.equal(blocks[0].type, "codeBlock");
      assert.equal(blocks[0].attrs?.language, "ts");
      assert.equal(
        blocks[0].content?.[0].text,
        "const x = `**not bold**`;\n# not a heading",
      );
    });

    it("reads horizontal rules without mistaking a list for one", () => {
      assert.deepEqual(types("a\n\n---\n\nb"), ["paragraph", "horizontalRule", "paragraph"]);
      assert.deepEqual(types("***"), ["horizontalRule"]);
      assert.deepEqual(types("- item"), ["bulletList"]);
    });

    it("never produces an empty document", () => {
      assert.deepEqual(types(""), ["paragraph"]);
      assert.deepEqual(types("   \n\n  "), ["paragraph"]);
    });
  });

  describe("inline marks", () => {
    it("reads bold, italic, strike and code", () => {
      assert.deepEqual(firstMarks(doc("**bold**")[0]), ["bold"]);
      assert.deepEqual(firstMarks(doc("__bold__")[0]), ["bold"]);
      assert.deepEqual(firstMarks(doc("*italic*")[0]), ["italic"]);
      assert.deepEqual(firstMarks(doc("_italic_")[0]), ["italic"]);
      assert.deepEqual(firstMarks(doc("~~gone~~")[0]), ["strike"]);
      assert.deepEqual(firstMarks(doc("`code`")[0]), ["code"]);
    });

    it("nests marks", () => {
      const marks = firstMarks(doc("**bold with *italic* inside**")[0]);
      assert.ok(marks.includes("bold"));
    });

    it("does not format inside a code span", () => {
      const paragraph = doc("Use `**literal**` here.")[0];
      const code = paragraph.content!.find((n) => n.marks?.some((m) => m.type === "code"));
      assert.equal(code?.text, "**literal**");
    });

    it("leaves an underscore inside a word alone", () => {
      // snake_case_names must not become italics.
      const paragraph = doc("The value is snake_case_here today.")[0];
      assert.equal(plainText(paragraph), "The value is snake_case_here today.");
      assert.deepEqual(firstMarks(paragraph), []);
    });

    it("reads links and keeps their text formatted", () => {
      const paragraph = doc("See [the **docs**](https://example.com/x) now.")[0];
      const linked = paragraph.content!.filter((n) =>
        n.marks?.some((m) => m.type === "link"),
      );
      assert.ok(linked.length > 0);
      assert.equal(
        linked[0].marks!.find((m) => m.type === "link")!.attrs!.href,
        "https://example.com/x",
      );
      assert.equal(plainText(paragraph), "See the docs now.");
    });

    it("drops a link whose scheme the editor would refuse", () => {
      // The editor allows http, https and mailto only; an import must not be
      // a way around that.
      for (const bad of ["javascript:alert(1)", "data:text/html,<script>"]) {
        const paragraph = doc(`A [click](${bad}) here.`)[0];
        assert.deepEqual(firstMarks(paragraph), [], bad);
        assert.equal(plainText(paragraph), "A click here.");
      }
      // mailto and site-relative survive.
      assert.deepEqual(firstMarks(doc("[mail](mailto:a@b.com)")[0]), ["link"]);
      assert.deepEqual(firstMarks(doc("[rel](/about)")[0]), ["link"]);
    });

    it("keeps a destination containing balanced parentheses intact", () => {
      // Wikipedia-style URLs are ordinary links; a pattern that stops at the
      // first ")" swallows half the URL and leaks the rest into the sentence.
      const paragraph = doc("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now.")[0];
      const link = paragraph.content!.find((n) =>
        n.marks?.some((m) => m.type === "link"),
      );
      assert.equal(
        link!.marks!.find((m) => m.type === "link")!.attrs!.href,
        "https://en.wikipedia.org/wiki/Foo_(bar)",
      );
      assert.equal(plainText(paragraph), "See Foo now.");
    });

    it("ignores the optional title after a destination", () => {
      const paragraph = doc('A [titled](https://example.com "The Title") link.')[0];
      const link = paragraph.content!.find((n) =>
        n.marks?.some((m) => m.type === "link"),
      );
      assert.equal(
        link!.marks!.find((m) => m.type === "link")!.attrs!.href,
        "https://example.com",
      );
    });

    it("turns two trailing spaces into a hard break, not a plain newline", () => {
      const withBreak = doc("first line  \nsecond line")[0];
      assert.ok(withBreak.content!.some((n) => n.type === "hardBreak"));

      const wrapped = doc("first line\nsecond line")[0];
      assert.ok(!wrapped.content!.some((n) => n.type === "hardBreak"));
    });
  });

  describe("images", () => {
    it("lifts an image out of the paragraph, since the editor forbids it inline", () => {
      const blocks = doc("Text before.\n\n![A harbour](https://example.com/a.png)");
      assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "image"]);
      assert.equal(blocks[1].attrs?.src, "https://example.com/a.png");
      assert.equal(blocks[1].attrs?.alt, "A harbour");
    });

    it("keeps the surrounding sentence when an image sits mid-paragraph", () => {
      const blocks = doc("Before ![alt](https://example.com/a.png) after.");
      assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "image"]);
      assert.equal(plainText(blocks[0]), "Before  after.");
    });

    it("resolves the reference-style images Google Docs exports", () => {
      const blocks = doc(
        "![the cover][image1]\n\n[image1]: https://example.com/cover.png",
      );
      assert.equal(blocks[0].type, "image");
      assert.equal(blocks[0].attrs?.src, "https://example.com/cover.png");
    });

    it("drops a reference with no definition rather than emitting a broken image", () => {
      assert.deepEqual(types("![missing][nope]"), ["paragraph"]);
    });

    it("drops an image with an unsafe source", () => {
      assert.deepEqual(types("![x](javascript:alert(1))"), ["paragraph"]);
    });
  });

  describe("metadata", () => {
    it("reads front matter", () => {
      const parsed = markdownToTiptap(
        "---\ntitle: From Front Matter\nexcerpt: A summary.\ntags: Essays, Craft\n---\n\nBody text.",
      );
      assert.equal(parsed.title, "From Front Matter");
      assert.equal(parsed.excerpt, "A summary.");
      assert.deepEqual(parsed.tags, ["Essays", "Craft"]);
      assert.deepEqual(parsed.doc.content?.map((b) => b.type), ["paragraph"]);
    });

    it("lifts a leading H1 into the title so it is not repeated in the body", () => {
      const parsed = markdownToTiptap("# The Long Way Round\n\nFirst paragraph.");
      assert.equal(parsed.title, "The Long Way Round");
      assert.deepEqual(parsed.doc.content?.map((b) => b.type), ["paragraph"]);
    });

    it("falls back to the file name", () => {
      const parsed = markdownToTiptap("Just a body.", "notes-from-a-walk");
      assert.equal(parsed.title, "notes-from-a-walk");
    });

    it("prefers front matter over a leading heading", () => {
      const parsed = markdownToTiptap("---\ntitle: Chosen\n---\n\n# Ignored\n\nBody.");
      assert.equal(parsed.title, "Chosen");
      // The H1 is only lifted when it is supplying the title.
      assert.equal(parsed.doc.content?.[0].type, "heading");
    });

    it("summarises the first paragraph when no excerpt is given", () => {
      const parsed = markdownToTiptap("# T\n\nA short opening line.\n\nMore.");
      assert.equal(parsed.excerpt, "A short opening line.");
    });

    it("trims a long summary at a sentence boundary", () => {
      const long = `${"Word ".repeat(30)}. And then a great deal more text follows on afterwards.`;
      const parsed = markdownToTiptap(`# T\n\n${long}`);
      assert.ok(parsed.excerpt!.length <= 201);
      assert.ok(parsed.excerpt!.endsWith(".") || parsed.excerpt!.endsWith("…"));
    });
  });

  describe("a Google Docs export end to end", () => {
    // Shaped like what Docs actually produces.
    const exported = [
      "# On Taking The Slow Route",
      "",
      "There is a particular kind of **impatience** that shows up in software.",
      "It looks like speed.",
      "",
      "## What it costs",
      "",
      "*   Rework, deferred",
      "*   Confidence, borrowed",
      "    *   And repaid with interest",
      "",
      "> The long way round is not slower.",
      "",
      "See [the earlier note](https://example.com/earlier) for context.",
      "",
      "![][image1]",
      "",
      "[image1]: https://example.com/diagram.png",
    ].join("\n");

    it("produces the whole document", () => {
      const parsed = markdownToTiptap(exported, "on-taking-the-slow-route.md");
      assert.equal(parsed.title, "On Taking The Slow Route");
      assert.deepEqual(parsed.doc.content?.map((b) => b.type), [
        "paragraph",
        "heading",
        "bulletList",
        "blockquote",
        "paragraph",
        "image",
      ]);

      const list = parsed.doc.content![2];
      assert.equal(list.content?.length, 2);
      assert.ok(
        list.content![1].content!.some((n) => n.type === "bulletList"),
        "the indented bullet should nest",
      );
      assert.equal(parsed.doc.content![5].attrs?.src, "https://example.com/diagram.png");
      assert.ok(parsed.excerpt?.startsWith("There is a particular kind"));
    });
  });
});
