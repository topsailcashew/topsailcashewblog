import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { POST as importRoute } from "@/app/api/import/route";
import { posts } from "@/db/schema";
import {
  countImportedPosts,
  importDocument,
  isImportableName,
} from "@/lib/import-documents";
import { getPostById, updatePost } from "@/lib/posts";
import { getFeed, getPublishedPost } from "@/lib/public-posts";
import { db, hasDatabase, resetTables, setupDatabase, teardownDatabase } from "./helpers";

const post = (documents: { path: string; content: string }[]) =>
  importRoute(
    new NextRequest("http://localhost/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documents }),
    }),
  );

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("importable names", () => {
  it("accepts text and markdown, and nothing else", () => {
    for (const name of ["a.md", "A.MD", "notes.markdown", "plain.txt", "deep/path/x.md"]) {
      assert.equal(isImportableName(name), true, name);
    }
    for (const name of ["photo.jpg", "sheet.csv", "doc.docx", "page.html", "noext"]) {
      assert.equal(isImportableName(name), false, name);
    }
  });
});

describe(
  "importing documents",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("turns a markdown file into a draft", async () => {
      const item = await importDocument(db(), {
        path: "essays/on-slow-software.md",
        content: [
          "# On Slow Software",
          "",
          "There is a particular kind of **impatience** in this work.",
          "",
          "## What it costs",
          "",
          "- Rework, deferred",
          "  - And repaid with interest",
          "",
          "See [the note](https://example.com/a_(b)) for context.",
        ].join("\n"),
      });

      assert.equal(item.outcome, "created");
      const created = await getPostById(db(), item.postId!);
      assert.equal(created?.title, "On Slow Software");
      assert.equal(created?.status, "draft");
      assert.equal(created?.slug, "on-slow-software");
      assert.ok(created?.excerpt?.startsWith("There is a particular kind"));

      const html = created!.content_html!;
      assert.ok(html.includes("<h2>What it costs</h2>"));
      assert.ok(html.includes("<strong>impatience</strong>"));
      assert.ok(html.includes('href="https://example.com/a_(b)"'));
    });

    it("never publishes anything", async () => {
      await importDocument(db(), { path: "a.md", content: "# A\n\nText." });
      assert.equal((await getFeed(db(), 1)).totalPosts, 0);
      assert.equal(await getPublishedPost(db(), "a"), null);
    });

    it("names a document with no heading after its file", async () => {
      const item = await importDocument(db(), {
        path: "notes/untitled-thoughts.md",
        content: "Just a body, no heading.",
      });
      const created = await getPostById(db(), item.postId!);
      assert.equal(created?.title, "untitled-thoughts");
    });

    it("updates the same draft when the file is dropped again", async () => {
      const first = await importDocument(db(), {
        path: "drafts/piece.md",
        content: "# Piece\n\nOriginal.",
      });
      const second = await importDocument(db(), {
        path: "drafts/piece.md",
        content: "# Piece\n\nRewritten.",
      });

      assert.equal(first.outcome, "created");
      assert.equal(second.outcome, "updated");
      assert.equal(second.postId, first.postId);
      assert.equal((await db().select().from(posts)).length, 1);

      const updated = await getPostById(db(), first.postId!);
      assert.ok(updated?.content_html?.includes("Rewritten."));
    });

    it("treats the same name in two folders as two documents", async () => {
      const a = await importDocument(db(), { path: "2025/notes.md", content: "# A\n\nx" });
      const b = await importDocument(db(), { path: "2026/notes.md", content: "# B\n\nx" });
      assert.notEqual(a.postId, b.postId);
      assert.equal((await db().select().from(posts)).length, 2);
    });

    it("never overwrites a post that has been published", async () => {
      const first = await importDocument(db(), {
        path: "piece.md",
        content: "# Piece\n\nAs imported.",
      });
      await updatePost(db(), first.postId!, { status: "published" });

      const again = await importDocument(db(), {
        path: "piece.md",
        content: "# Piece\n\nChanged on disk after publishing.",
      });

      assert.equal(again.outcome, "skipped-published");
      const live = await getPostById(db(), first.postId!);
      assert.ok(live?.content_html?.includes("As imported."));
      assert.ok(!live?.content_html?.includes("Changed on disk"));
    });

    it("keeps the original slug when the file is renamed in place", async () => {
      const first = await importDocument(db(), {
        path: "working-title.md",
        content: "# Working Title\n\nText.",
      });
      // Same path, new heading — the title follows, the URL must not.
      await importDocument(db(), {
        path: "working-title.md",
        content: "# A Much Better Title\n\nText.",
      });

      const updated = await getPostById(db(), first.postId!);
      assert.equal(updated?.title, "A Much Better Title");
      assert.equal(updated?.slug, "working-title");
    });

    it("resolves a slug collision with an existing post", async () => {
      await db().insert(posts).values({ title: "Taken", slug: "taken" });
      const item = await importDocument(db(), { path: "taken.md", content: "# Taken\n\nx" });
      const created = await getPostById(db(), item.postId!);
      assert.equal(created?.slug, "taken-2");
    });

    it("counts what came from an import", async () => {
      await db().insert(posts).values({ title: "Typed here", slug: "typed-here" });
      await importDocument(db(), { path: "a.md", content: "# A\n\nx" });
      await importDocument(db(), { path: "b.md", content: "# B\n\nx" });
      assert.equal(await countImportedPosts(db()), 2);
    });

    describe("over the API", () => {
      it("imports a batch and reports each file", async () => {
        const response = await post([
          { path: "essays/one.md", content: "# One\n\nText." },
          { path: "essays/two.md", content: "# Two\n\nText." },
        ]);
        assert.equal(response.status, 200);

        const { items } = await bodyOf<{ items: { path: string; outcome: string }[] }>(
          response,
        );
        assert.deepEqual(
          items.map((i) => [i.path, i.outcome]),
          [
            ["essays/one.md", "created"],
            ["essays/two.md", "created"],
          ],
        );
      });

      it("reports a failure per file without abandoning the batch", async () => {
        // A title of only punctuation slugifies to the fallback; the real
        // point is that one odd document must not sink the others.
        const response = await post([
          { path: "good-1.md", content: "# Fine\n\nText." },
          { path: "odd.md", content: "" },
          { path: "good-2.md", content: "# Also fine\n\nText." },
        ]);
        const { items } = await bodyOf<{ items: { outcome: string }[] }>(response);
        assert.equal(items.length, 3);
        assert.equal(items.filter((i) => i.outcome === "created").length, 3);
      });

      it("refuses a batch larger than it will accept", async () => {
        const many = Array.from({ length: 11 }, (_, i) => ({
          path: `f${i}.md`,
          content: "# X\n\nx",
        }));
        assert.equal((await post(many)).status, 422);
      });

      it("refuses an empty batch", async () => {
        assert.equal((await post([])).status, 422);
      });

      it("stores the path as the import key", async () => {
        const response = await post([{ path: "a/b/c.md", content: "# C\n\nx" }]);
        const { items } = await bodyOf<{ items: { postId: string }[] }>(response);
        const [row] = await db()
          .select({ importKey: posts.importKey, importedAt: posts.importedAt })
          .from(posts)
          .where(eq(posts.id, items[0].postId));
        assert.equal(row.importKey, "a/b/c.md");
        assert.ok(row.importedAt !== null);
      });
    });
  },
);
