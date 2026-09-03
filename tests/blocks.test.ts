import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { toBlocks, toRichText } from "@/lib/blocks";
import { repoint, rewriteDocument, rewriteInternalLinks } from "@/lib/internal-links";
import { createPost, updatePost } from "@/lib/posts";
import { createPage } from "@/lib/pages";
import {
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

const doc = (...content: unknown[]) => ({ type: "doc", content });

/** Matches the mark shape `toRichText` reads, so the helper types check. */
type Mark = { type?: string; attrs?: Record<string, unknown> };
const text = (value: string, marks?: Mark[]) => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});

describe("block format", () => {
  it("maps each editor node onto a named block", () => {
    const blocks = toBlocks(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("A heading")] },
        { type: "paragraph", content: [text("Some prose.")] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [text("One")] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [text("Two")] }] },
          ],
        },
        { type: "blockquote", content: [{ type: "paragraph", content: [text("Quoted")] }] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const x = 1;")] },
        { type: "image", attrs: { src: "/media/a.jpg", alt: "A photo" } },
        { type: "horizontalRule" },
      ),
    );

    assert.deepEqual(
      blocks.map((block) => block.type),
      ["heading", "paragraph", "list", "quote", "code", "image", "divider"],
    );
    assert.equal(blocks[0].type === "heading" && blocks[0].level, 2);
    assert.equal(blocks[2].type === "list" && blocks[2].ordered, false);
    assert.equal(blocks[4].type === "code" && blocks[4].language, "ts");
    assert.equal(blocks[5].type === "image" && blocks[5].alt, "A photo");
  });

  it("flattens the paragraph the editor nests inside every list item", () => {
    const blocks = toBlocks(
      doc({
        type: "orderedList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [text("First")] }] },
        ],
      }),
    );
    assert.deepEqual(blocks[0].type === "list" && blocks[0].items, [
      { text: "First", spans: [] },
    ]);
  });

  it("drops the empty paragraphs the editor uses to hold a cursor", () => {
    const blocks = toBlocks(
      doc(
        { type: "paragraph", content: [] },
        { type: "paragraph", content: [text("Real content")] },
        { type: "paragraph", content: [text("   ")] },
      ),
    );
    assert.equal(blocks.length, 1);
  });

  it("carries an empty alt through as decorative rather than dropping it", () => {
    const blocks = toBlocks(doc({ type: "image", attrs: { src: "/a.jpg", alt: "" } }));
    assert.equal(blocks[0].type === "image" && blocks[0].alt, "");
  });

  it("keeps the words from a node type it does not recognise", () => {
    const blocks = toBlocks(
      doc({
        type: "someFutureNode",
        content: [{ type: "paragraph", content: [text("Still readable")] }],
      }),
    );
    assert.equal(blocks[0].type === "paragraph" && blocks[0].text, "Still readable");
  });
});

describe("rich text spans", () => {
  it("records formatting as offsets into the text", () => {
    const rich = toRichText([
      text("Plain "),
      text("bold", [{ type: "bold" }]),
      text(" end"),
    ]);
    assert.equal(rich.text, "Plain bold end");
    assert.deepEqual(rich.spans, [{ start: 6, end: 10, type: "bold" }]);
  });

  it("merges runs the editor happened to split", () => {
    // Typing "bold" then editing the middle leaves two adjacent text nodes
    // with the same mark. A consumer should see one span, not two touching.
    const rich = toRichText([
      text("bo", [{ type: "bold" }]),
      text("ld", [{ type: "bold" }]),
    ]);
    assert.deepEqual(rich.spans, [{ start: 0, end: 4, type: "bold" }]);
  });

  it("does not merge two different links that happen to touch", () => {
    const rich = toRichText([
      text("one", [{ type: "link", attrs: { href: "https://a.example" } }]),
      text("two", [{ type: "link", attrs: { href: "https://b.example" } }]),
    ]);
    assert.equal(rich.spans.length, 2);
    assert.equal(rich.spans[0].href, "https://a.example");
    assert.equal(rich.spans[1].href, "https://b.example");
  });

  it("drops a link scheme a client should never follow", () => {
    const rich = toRichText([
      // eslint-disable-next-line no-script-url
      text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
      text("ok", [{ type: "link", attrs: { href: "/about" } }]),
    ]);
    assert.equal(rich.spans.length, 1);
    assert.equal(rich.spans[0].href, "/about");
  });

  it("turns a hard break into a newline in the text", () => {
    const rich = toRichText([text("one"), { type: "hardBreak" }, text("two")]);
    assert.equal(rich.text, "one\ntwo");
  });
});

describe("link repointing", () => {
  it("moves a plain path", () => {
    assert.equal(repoint("/old", "/old", "/new"), "/new");
  });

  it("keeps the fragment and query", () => {
    assert.equal(repoint("/old#part-two", "/old", "/new"), "/new#part-two");
    assert.equal(repoint("/old?utm_source=x", "/old", "/new"), "/new?utm_source=x");
  });

  it("matches the forms a path can be written in", () => {
    assert.equal(repoint("/Old/", "/old", "/new"), "/new");
  });

  it("moves an absolute URL on this site's own origin", () => {
    assert.equal(
      repoint("https://blog.example/old", "/old", "/new", ["https://blog.example"]),
      "https://blog.example/new",
    );
  });

  it("leaves another site alone, even at the same path", () => {
    assert.equal(
      repoint("https://elsewhere.example/old", "/old", "/new", ["https://blog.example"]),
      "https://elsewhere.example/old",
    );
    assert.equal(repoint("//elsewhere.example/old", "/old", "/new"), "//elsewhere.example/old");
  });

  it("leaves a path that merely starts the same", () => {
    assert.equal(repoint("/old-and-different", "/old", "/new"), "/old-and-different");
  });

  it("rewrites links and image sources through a whole document", () => {
    const { doc: rewritten, changed } = rewriteDocument(
      doc(
        {
          type: "paragraph",
          content: [text("see", [{ type: "link", attrs: { href: "/old#a" } }])],
        },
        { type: "image", attrs: { src: "/old", alt: "" } },
        {
          type: "paragraph",
          content: [text("other", [{ type: "link", attrs: { href: "/untouched" } }])],
        },
      ),
      "/old",
      "/new",
    );

    assert.equal(changed, 2);
    const json = JSON.stringify(rewritten);
    assert.ok(json.includes('"/new#a"'));
    assert.ok(json.includes('"/untouched"'));
    assert.ok(!json.includes('"/old'));
  });

  it("returns a copy rather than editing the row's own object", () => {
    const original = doc({
      type: "paragraph",
      content: [text("x", [{ type: "link", attrs: { href: "/old" } }])],
    });
    const snapshot = JSON.stringify(original);
    rewriteDocument(original, "/old", "/new");
    assert.equal(JSON.stringify(original), snapshot, "the input was mutated");
  });
});

describe(
  "self-healing links",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    /** A document with one link to `href`. */
    function linking(href: string) {
      return doc({
        type: "paragraph",
        content: [
          { type: "text", text: "As argued " },
          { type: "text", text: "here", marks: [{ type: "link", attrs: { href } }] },
          { type: "text", text: "." },
        ],
      });
    }

    it("repoints another post's link when a slug changes", async () => {
      const target = await createPost(db(), { title: "Slow Software" });
      const citing = await createPost(db(), {
        title: "A citing post",
        content_json: linking(`/${target.slug}`),
        content_html: '<p>As argued <a href="/slow-software">here</a>.</p>',
      });

      await updatePost(db(), target.id, { slug: "on-slow-software" });

      const { getPostById } = await import("@/lib/posts");
      const updated = await getPostById(db(), citing.id);
      assert.match(JSON.stringify(updated?.content_json), /\/on-slow-software/);
      assert.ok(!JSON.stringify(updated?.content_json).includes('"/slow-software"'));
    });

    it("re-renders the HTML too, so the reading page shows the new link", async () => {
      const target = await createPost(db(), { title: "Target" });
      const citing = await createPost(db(), {
        title: "Citing",
        content_json: linking("/target"),
        content_html: '<p>As argued <a href="/target">here</a>.</p>',
      });

      await updatePost(db(), target.id, { slug: "moved" });

      const { getPostById } = await import("@/lib/posts");
      const updated = await getPostById(db(), citing.id);
      assert.match(updated?.content_html ?? "", /href="\/moved"/);
    });

    it("fixes pages as well as posts", async () => {
      const target = await createPost(db(), { title: "Target" });
      const page = await createPage(db(), {
        title: "Colophon",
        content_json: linking("/target"),
        content_html: '<p><a href="/target">here</a></p>',
      });

      await updatePost(db(), target.id, { slug: "moved" });

      const { getPageById } = await import("@/lib/pages");
      const updated = await getPageById(db(), page.id);
      assert.match(JSON.stringify(updated?.content_json), /\/moved/);
    });

    it("leaves a link to a different post alone", async () => {
      const target = await createPost(db(), { title: "Target" });
      await createPost(db(), { title: "Other", slug: "other" });
      const citing = await createPost(db(), {
        title: "Citing",
        content_json: linking("/other"),
        content_html: '<p><a href="/other">here</a></p>',
      });

      await updatePost(db(), target.id, { slug: "moved" });

      const { getPostById } = await import("@/lib/posts");
      const updated = await getPostById(db(), citing.id);
      assert.match(JSON.stringify(updated?.content_json), /"\/other"/);
    });

    it("reports what it changed", async () => {
      await createPost(db(), {
        title: "One",
        content_json: linking("/old"),
        content_html: '<p><a href="/old">a</a></p>',
      });
      await createPost(db(), {
        title: "Two",
        content_json: linking("/old"),
        content_html: '<p><a href="/old">a</a></p>',
      });

      const result = await rewriteInternalLinks(db(), "/old", "/new");
      assert.deepEqual(result, { posts: 2, pages: 0, links: 2 });
    });

    it("does nothing when the slug did not really change", async () => {
      const result = await rewriteInternalLinks(db(), "/same", "/same");
      assert.deepEqual(result, { posts: 0, pages: 0, links: 0 });
    });
  },
);
