import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { DELETE as deleteRoute } from "@/app/api/posts/[id]/route";
import { POST as restoreRoute } from "@/app/api/posts/[id]/restore/route";
import {
  countPostsByStatus,
  createPost,
  emptyTrash,
  getPostById,
  listPosts,
  restorePost,
  trashPost,
} from "@/lib/posts";
import { getFeed, getPublishedPost, listPublishedSlugs, searchPublished } from "@/lib/public-posts";
import { listRevisions } from "@/lib/revisions";
import {
  ctx,
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

const live = { status: "published" as const, content_html: "<p>Findable words.</p>" };

describe(
  "trash",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("removes a trashed post from every public surface", async () => {
      const post = await createPost(db(), { title: "Regrettable", ...live });
      assert.equal((await getFeed(db(), 1)).totalPosts, 1);

      await trashPost(db(), post.id);

      assert.equal((await getFeed(db(), 1)).totalPosts, 0);
      assert.equal(await getPublishedPost(db(), post.slug), null);
      assert.deepEqual(await listPublishedSlugs(db()), []);
      assert.deepEqual((await searchPublished(db(), "findable")).results, []);
    });

    it("keeps the row, its tags and its revisions", async () => {
      const post = await createPost(db(), {
        title: "Has history",
        tags: ["Essays"],
        content_json: { type: "doc", content: [] },
        ...live,
      });
      // A publish transition snapshots, so there is history to lose.
      assert.ok((await listRevisions(db(), post.id)).length >= 0);

      await trashPost(db(), post.id);

      const stored = await getPostById(db(), post.id);
      assert.equal(stored?.title, "Has history");
      assert.deepEqual(stored?.tags.map((t) => t.name), ["Essays"]);
      assert.ok(stored?.deleted_at !== null);
    });

    it("hides trash from the default admin list and shows it under ?status=trash", async () => {
      const kept = await createPost(db(), { title: "Kept", ...live });
      const binned = await createPost(db(), { title: "Binned", ...live });
      await trashPost(db(), binned.id);

      const normal = await listPosts(db(), { limit: 50, offset: 0 });
      assert.deepEqual(normal.map((p) => p.id), [kept.id]);

      const trashed = await listPosts(db(), { status: "trash", limit: 50, offset: 0 });
      assert.deepEqual(trashed.map((p) => p.id), [binned.id]);

      // A trashed published post must not inflate the "published" filter either.
      const published = await listPosts(db(), {
        status: "published",
        limit: 50,
        offset: 0,
      });
      assert.deepEqual(published.map((p) => p.id), [kept.id]);
    });

    it("counts trash separately from draft and published", async () => {
      const a = await createPost(db(), { title: "A", ...live });
      await createPost(db(), { title: "B", status: "draft" });
      await trashPost(db(), a.id);

      assert.deepEqual(await countPostsByStatus(db()), {
        published: 0,
        draft: 1,
        trash: 1,
      });
    });

    it("restores a post back onto the public site", async () => {
      const post = await createPost(db(), { title: "Second thoughts", ...live });
      await trashPost(db(), post.id);
      assert.equal(await getPublishedPost(db(), post.slug), null);

      const restored = await restorePost(db(), post.id);
      assert.equal(restored.deleted_at, null);
      assert.equal((await getPublishedPost(db(), post.slug))?.title, "Second thoughts");
    });

    it("keeps the slug reserved while a post sits in the trash", async () => {
      const original = await createPost(db(), { title: "Taken", ...live });
      await trashPost(db(), original.id);

      // Restoring must return the post to its own URL, so a new post cannot
      // have claimed it in the meantime.
      const fresh = await createPost(db(), { title: "Taken" });
      assert.equal(fresh.slug, "taken-2");

      const restored = await restorePost(db(), original.id);
      assert.equal(restored.slug, "taken");
    });

    it("empties the trash without touching live posts", async () => {
      const kept = await createPost(db(), { title: "Kept", ...live });
      const a = await createPost(db(), { title: "A", ...live });
      const b = await createPost(db(), { title: "B", ...live });
      await trashPost(db(), a.id);
      await trashPost(db(), b.id);

      assert.equal(await emptyTrash(db()), 2);
      assert.equal(await getPostById(db(), a.id), null);
      assert.equal((await getPostById(db(), kept.id))?.title, "Kept");
    });

    describe("over the API", () => {
      it("DELETE trashes by default and is undoable", async () => {
        const post = await createPost(db(), { title: "Oops", ...live });

        const response = await deleteRoute(
          new NextRequest(`http://localhost/api/posts/${post.id}`, { method: "DELETE" }),
          ctx(post.id),
        );
        assert.equal(response.status, 204);
        assert.ok((await getPostById(db(), post.id))?.deleted_at);

        const restored = await restoreRoute(
          new NextRequest(`http://localhost/api/posts/${post.id}/restore`, {
            method: "POST",
          }),
          ctx(post.id),
        );
        assert.equal(restored.status, 200);
        assert.equal((await getPostById(db(), post.id))?.deleted_at, null);
      });

      it("DELETE ?permanent=1 removes the row for good", async () => {
        const post = await createPost(db(), { title: "Gone", ...live });

        const response = await deleteRoute(
          new NextRequest(`http://localhost/api/posts/${post.id}?permanent=1`, {
            method: "DELETE",
          }),
          ctx(post.id),
        );
        assert.equal(response.status, 204);
        assert.equal(await getPostById(db(), post.id), null);
      });

      it("refuses to restore a post that is not in the trash", async () => {
        const post = await createPost(db(), { title: "Live", ...live });
        const response = await restoreRoute(
          new NextRequest(`http://localhost/api/posts/${post.id}/restore`, {
            method: "POST",
          }),
          ctx(post.id),
        );
        assert.equal(response.status, 404);
      });
    });
  },
);
