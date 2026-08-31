import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { DELETE as deletePageRoute, PATCH as patchPageRoute } from "@/app/api/pages/[id]/route";
import { POST as createPageRoute } from "@/app/api/pages/route";
import { isProtected } from "@/lib/auth";
import {
  createPage,
  getPublishedPage,
  listPublishedPageSlugs,
  updatePage,
} from "@/lib/pages";
import { createPost } from "@/lib/posts";
import { RESERVED_SLUGS } from "@/lib/slug";
import {
  bodyOf,
  ctx,
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

describe(
  "standalone pages",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("keeps an unpublished page unreachable", async () => {
      const page = await createPage(db(), { title: "About", status: "draft" });
      assert.equal(await getPublishedPage(db(), page.slug), null);
      assert.deepEqual(await listPublishedPageSlugs(db()), []);

      await updatePage(db(), page.id, { status: "published" });
      assert.equal((await getPublishedPage(db(), "about"))?.title, "About");
    });

    it("does not let a page take a slug a post already holds", async () => {
      const post = await createPost(db(), { title: "Contact", status: "published" });
      assert.equal(post.slug, "contact");

      // /[slug] resolves posts first, so an identical page slug would render
      // the post and leave the page permanently unreachable.
      const page = await createPage(db(), { title: "Contact" });
      assert.notEqual(page.slug, post.slug);
      assert.equal(page.slug, "contact-2");
    });

    it("does not let a post take a slug a page already holds", async () => {
      await createPage(db(), { title: "About", status: "published" });
      const post = await createPost(db(), { title: "About" });
      assert.equal(post.slug, "about-2");
    });

    it("refuses a slug the router owns", async () => {
      const response = await createPageRoute(
        new NextRequest("http://localhost/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Search", slug: "search" }),
        }),
      );
      assert.equal(response.status, 422);
      assert.ok(RESERVED_SLUGS.has("search"));
    });

    it("bumps a derived slug off a reserved name rather than failing", async () => {
      // The title is the author's; the collision is ours to resolve quietly.
      const page = await createPage(db(), { title: "Search" });
      assert.equal(page.slug, "search-2");
    });

    it("creates, renames and deletes over the API", async () => {
      const created = await createPageRoute(
        new NextRequest("http://localhost/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Newsletter",
            content_html: "<p>Soon.</p>",
            status: "published",
          }),
        }),
      );
      assert.equal(created.status, 201);
      const { page } = await bodyOf<{ page: { id: string; slug: string } }>(created);
      assert.equal(page.slug, "newsletter");

      const renamed = await patchPageRoute(
        new NextRequest(`http://localhost/api/pages/${page.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: "letters" }),
        }),
        ctx(page.id),
      );
      assert.equal(renamed.status, 200);
      assert.equal(await getPublishedPage(db(), "newsletter"), null);
      assert.equal((await getPublishedPage(db(), "letters"))?.title, "Newsletter");

      const removed = await deletePageRoute(
        new NextRequest(`http://localhost/api/pages/${page.id}`, { method: "DELETE" }),
        ctx(page.id),
      );
      assert.equal(removed.status, 204);
      assert.equal(await getPublishedPage(db(), "letters"), null);
    });

    it("gates every page write behind the session", () => {
      for (const method of ["POST", "PATCH", "DELETE"]) {
        assert.equal(isProtected("/api/pages", method), true);
        assert.equal(isProtected("/api/pages/abc", method), true);
      }
      // Unlike posts, there is no public read surface for the pages API — the
      // public site reads pages through the database, not over HTTP.
      assert.equal(isProtected("/api/pages", "GET"), true);
    });

    it("keeps every read of the posts API behind the session", () => {
      // Including the plain list, which `?status=draft` turned into a full
      // dump of unpublished writing while it was open.
      assert.equal(isProtected("/api/posts", "GET"), true);
      assert.equal(isProtected("/api/posts/abc", "GET"), true);
      assert.equal(isProtected("/api/posts/abc/revisions", "GET"), true);
      assert.equal(isProtected("/api/posts/abc/preview", "POST"), true);
    });
  },
);
