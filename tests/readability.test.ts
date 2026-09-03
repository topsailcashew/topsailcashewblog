import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { stripFileExtension } from "@/lib/import-documents";
import { createPost } from "@/lib/posts";
import { excerptFor, searchPublished, toSummary } from "@/lib/public-posts";
import {
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

describe("derived excerpts", () => {
  it("keeps the post's own excerpt when it has one", () => {
    assert.equal(
      excerptFor({ excerpt: "Written by hand.", content_html: "<p>Something else.</p>" }),
      "Written by hand.",
    );
  });

  it("borrows the opening when the excerpt is missing", () => {
    // The card is a fixed height in the grid, so a post with no excerpt leaves
    // a visible hole in the column rather than simply a shorter card.
    assert.equal(
      excerptFor({ excerpt: null, content_html: "<p>The opening sentence.</p>" }),
      "The opening sentence.",
    );
  });

  it("treats a blank excerpt as missing", () => {
    assert.equal(
      excerptFor({ excerpt: "   ", content_html: "<p>Fallback.</p>" }),
      "Fallback.",
    );
  });

  it("puts a space where a block ended, so words do not run together", () => {
    assert.equal(
      excerptFor({ excerpt: null, content_html: "<p>One.</p><p>Two.</p>" }),
      "One. Two.",
    );
  });

  it("cuts at a word boundary and marks the cut", () => {
    const text = "word ".repeat(80).trim();
    const derived = excerptFor({ excerpt: null, content_html: `<p>${text}</p>` });

    assert.ok(derived);
    assert.ok(derived.endsWith("…"), `no ellipsis: ${derived.slice(-12)}`);
    assert.ok(derived.length <= 182, `too long: ${derived.length}`);
    // Cut mid-word it would end "wo…"; cut at a boundary it ends on a whole one.
    assert.ok(/word…$/.test(derived), derived);
  });

  it("decodes entities rather than showing them raw", () => {
    assert.equal(
      excerptFor({ excerpt: null, content_html: "<p>Tom &amp; Jerry &quot;go&quot;</p>" }),
      'Tom & Jerry "go"',
    );
  });

  it("returns null for a post with no words at all", () => {
    assert.equal(excerptFor({ excerpt: null, content_html: null }), null);
    assert.equal(excerptFor({ excerpt: null, content_html: "<p></p>" }), null);
  });

  it("reaches the card through toSummary", () => {
    const summary = toSummary({
      id: "1", title: "T", slug: "t", content_json: null,
      content_html: "<p>Borrowed opening.</p>", excerpt: null,
      cover_image_url: null, status: "published",
      published_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", series_id: null, meta_title: null,
      meta_description: null, canonical_url: null, noindex: false, og_image_url: null,
      featured: false, deleted_at: null, tags: [],
    });
    assert.equal(summary.excerpt, "Borrowed opening.");
  });
});

describe("file extensions in titles", () => {
  it("strips the extensions the importer accepts", () => {
    assert.equal(stripFileExtension("Where is the Urgency.docx"), "Where is the Urgency");
    assert.equal(stripFileExtension("notes.md"), "notes");
    assert.equal(stripFileExtension("notes.markdown"), "notes");
    assert.equal(stripFileExtension("notes.txt"), "notes");
    assert.equal(stripFileExtension("CAPS.DOCX"), "CAPS");
  });

  it("leaves a title whose full stop is not an extension", () => {
    assert.equal(stripFileExtension("Everything, Everything"), "Everything, Everything");
    assert.equal(stripFileExtension("On v1.2 of the plan"), "On v1.2 of the plan");
    // The one that matters: a real sentence ending in a word, not a suffix.
    assert.equal(stripFileExtension("A letter, and a promise"), "A letter, and a promise");
  });

  it("only strips a trailing extension, not one in the middle", () => {
    assert.equal(stripFileExtension("draft.docx notes"), "draft.docx notes");
  });
});

describe(
  "typo-tolerant search",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    async function seed() {
      await createPost(db(), {
        title: "Notes on slow software",
        excerpt: "Why waiting is often the fastest thing available.",
        content_html: "<p>Software gets faster and the waiting stays the same.</p>",
        status: "published",
      });
      await createPost(db(), {
        title: "New Paths",
        excerpt: "I have done so many personality tests.",
        content_html: "<p>Observing myself long enough to know.</p>",
        status: "published",
      });
    }

    it("still prefers an exact full-text match", async () => {
      await seed();
      const results = await searchPublished(db(), "slow software");
      assert.equal(results[0]?.title, "Notes on slow software");
    });

    it("finds a post through a transposed pair of letters", async () => {
      await seed();
      // "slwo" stems to a word in no document, so full-text returns nothing.
      const results = await searchPublished(db(), "slwo software");
      assert.equal(results[0]?.title, "Notes on slow software", "trigram fallback missed");
    });

    it("finds a post through a dropped letter in the excerpt", async () => {
      await seed();
      const results = await searchPublished(db(), "personalty");
      assert.equal(results[0]?.title, "New Paths");
    });

    it("still returns nothing for a query that resembles nothing", async () => {
      await seed();
      // The fallback must not become "always return something" — a confident
      // wrong answer is worse than the empty state the page now renders.
      assert.deepEqual(await searchPublished(db(), "qwertyuiop zxcvbnm"), []);
    });

    it("never reaches a draft through the fuzzy path", async () => {
      await createPost(db(), {
        title: "Unpublished thoughts",
        excerpt: "Not for reading yet.",
        content_html: "<p>Draft.</p>",
        status: "draft",
      });
      assert.deepEqual(await searchPublished(db(), "unpublishd thoughts"), []);
    });
  },
);
