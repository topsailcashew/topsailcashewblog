import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createPage, updatePage } from "@/lib/pages";
import { createPost, updatePost } from "@/lib/posts";
import {
  createRedirect,
  deleteRedirect,
  findRedirect,
  listRedirects,
  normalizePath,
} from "@/lib/redirects";
import {
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

describe("path normalisation", () => {
  it("reduces the forms a link can arrive in to one key", () => {
    const cases: [string, string][] = [
      ["/old-post", "/old-post"],
      ["old-post", "/old-post"],
      ["/Old-Post", "/old-post"],
      ["/old-post/", "/old-post"],
      ["/old-post?utm_source=x", "/old-post"],
      ["/old-post#section", "/old-post"],
      ["https://example.com/old-post", "/old-post"],
      ["/", "/"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizePath(input), expected, input);
    }
  });
});

describe(
  "redirects",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("records the old URL when a post slug changes", async () => {
      const post = await createPost(db(), { title: "Original Title" });
      assert.equal(post.slug, "original-title");

      await updatePost(db(), post.id, { slug: "better-title" });

      assert.equal(await findRedirect(db(), "/original-title"), "/better-title");
    });

    it("does the same for a page", async () => {
      const page = await createPage(db(), { title: "About Us" });
      await updatePage(db(), page.id, { slug: "about" });
      assert.equal(await findRedirect(db(), "/about-us"), "/about");
    });

    it("collapses a chain so there is only ever one hop", async () => {
      const post = await createPost(db(), { title: "One" });
      await updatePost(db(), post.id, { slug: "two" });
      await updatePost(db(), post.id, { slug: "three" });

      // /one must point at the current location, not at /two — which is itself
      // a redirect now, and would cost a second round trip.
      assert.equal(await findRedirect(db(), "/one"), "/three");
      assert.equal(await findRedirect(db(), "/two"), "/three");
    });

    it("never leaves a post redirecting to itself", async () => {
      const post = await createPost(db(), { title: "Back And Forth" });
      await updatePost(db(), post.id, { slug: "renamed" });
      await updatePost(db(), post.id, { slug: "back-and-forth" });

      // Renaming back would otherwise leave /back-and-forth -> /back-and-forth,
      // a loop the router follows forever.
      assert.equal(await findRedirect(db(), "/back-and-forth"), null);
      assert.equal(await findRedirect(db(), "/renamed"), "/back-and-forth");
    });

    it("drops a redirect away from a path that is now occupied", async () => {
      const post = await createPost(db(), { title: "Alpha" });
      await updatePost(db(), post.id, { slug: "beta" });
      assert.equal(await findRedirect(db(), "/alpha"), "/beta");

      // Something moves *into* /alpha. The old row pointing away from it must
      // go, or the new occupant is unreachable.
      const other = await createPost(db(), { title: "Newcomer" });
      await updatePost(db(), other.id, { slug: "alpha" });

      assert.equal(await findRedirect(db(), "/alpha"), null);
    });

    it("matches regardless of case, trailing slash or query string", async () => {
      const post = await createPost(db(), { title: "Case Test" });
      await updatePost(db(), post.id, { slug: "renamed-case" });

      for (const variant of ["/Case-Test", "/case-test/", "/case-test?ref=twitter"]) {
        assert.equal(await findRedirect(db(), variant), "/renamed-case", variant);
      }
    });

    it("does not record anything when the slug is unchanged", async () => {
      const post = await createPost(db(), { title: "Steady" });
      await updatePost(db(), post.id, { title: "Steady, retitled" });
      assert.deepEqual(await listRedirects(db()), []);
    });

    it("accepts a hand-written redirect and refuses a self-referential one", async () => {
      const created = await createRedirect(db(), "/typo-url", "/real-url");
      assert.equal(created.automatic, false);
      assert.equal(await findRedirect(db(), "/typo-url"), "/real-url");

      await assert.rejects(() => createRedirect(db(), "/loop", "/loop"), /itself/);
    });

    it("allows an off-site destination", async () => {
      await createRedirect(db(), "/old-home", "https://elsewhere.example/new");
      assert.equal(
        await findRedirect(db(), "/old-home"),
        "https://elsewhere.example/new",
      );
    });

    it("replaces rather than duplicates when the same source is added twice", async () => {
      await createRedirect(db(), "/dupe", "/first");
      await createRedirect(db(), "/dupe", "/second");
      const all = await listRedirects(db());
      assert.equal(all.length, 1);
      assert.equal(all[0].to_path, "/second");
    });

    it("deletes one", async () => {
      const created = await createRedirect(db(), "/gone", "/somewhere");
      await deleteRedirect(db(), created.id);
      assert.equal(await findRedirect(db(), "/gone"), null);
    });

    it("marks automatic and manual rows differently", async () => {
      const post = await createPost(db(), { title: "Auto" });
      await updatePost(db(), post.id, { slug: "auto-renamed" });
      await createRedirect(db(), "/manual", "/target");

      const rows = await listRedirects(db());
      const auto = rows.find((r) => r.from_path === "/auto");
      const manual = rows.find((r) => r.from_path === "/manual");
      assert.equal(auto?.automatic, true);
      assert.equal(manual?.automatic, false);
    });
  },
);
