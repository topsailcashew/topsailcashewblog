import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { posts } from "@/db/schema";
import { createPost, trashPost, updatePost } from "@/lib/posts";
import { getFeaturedPost } from "@/lib/public-posts";
import { db, hasDatabase, resetTables, setupDatabase, teardownDatabase } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const inDays = (n: number) => new Date(Date.now() + n * DAY);

async function publish(title: string, publishedAt: Date) {
  const [row] = await db()
    .insert(posts)
    .values({
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      contentHtml: "<p>Body.</p>",
      status: "published",
      publishedAt,
    })
    .returning();
  return row;
}

describe(
  "the featured post",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("leads with the newest published post when nothing is marked", async () => {
      await publish("Older", daysAgo(5));
      const newest = await publish("Newest", daysAgo(1));
      // The home page should never have a hole in it because a box was not
      // ticked, so an unmarked blog still leads with something sensible.
      assert.equal((await getFeaturedPost(db()))?.slug, newest.slug);
    });

    it("prefers a post that has been marked over a newer one", async () => {
      const marked = await publish("Chosen", daysAgo(9));
      await publish("Newer But Not Chosen", daysAgo(1));
      await updatePost(db(), marked.id, { featured: true });

      assert.equal((await getFeaturedPost(db()))?.slug, "chosen");
    });

    it("takes the newest of several marked posts", async () => {
      const older = await publish("Marked Older", daysAgo(9));
      const newer = await publish("Marked Newer", daysAgo(2));
      await updatePost(db(), older.id, { featured: true });
      await updatePost(db(), newer.id, { featured: true });

      // Nothing enforces a single featured row; the newest simply wins, so
      // featuring a post stays one write.
      assert.equal((await getFeaturedPost(db()))?.slug, "marked-newer");
    });

    it("carries the cover image and tags the hero needs", async () => {
      const post = await publish("With Art", daysAgo(1));
      await updatePost(db(), post.id, {
        cover_image_url: "/media/2026/09/cover.png",
        excerpt: "A summary.",
        tags: ["Essays"],
        featured: true,
      });

      const featured = await getFeaturedPost(db());
      assert.equal(featured?.coverImageUrl, "/media/2026/09/cover.png");
      assert.equal(featured?.excerpt, "A summary.");
      assert.deepEqual(featured?.tags.map((t) => t.name), ["Essays"]);
      assert.ok((featured?.readingMinutes ?? 0) >= 1);
    });

    describe("never leads with something a reader cannot open", () => {
      it("ignores a marked draft", async () => {
        const draft = await createPost(db(), { title: "Draft", status: "draft" });
        await updatePost(db(), draft.id, { featured: true });
        assert.equal(await getFeaturedPost(db()), null);
      });

      it("ignores a marked post that is not due yet", async () => {
        const scheduled = await publish("Later", inDays(7));
        await updatePost(db(), scheduled.id, { featured: true });
        assert.equal(await getFeaturedPost(db()), null);
      });

      it("ignores a marked post once it is trashed", async () => {
        const live = await publish("Live", daysAgo(1));
        await updatePost(db(), live.id, { featured: true });
        assert.equal((await getFeaturedPost(db()))?.slug, "live");

        await trashPost(db(), live.id);
        assert.equal(await getFeaturedPost(db()), null);
      });

      it("falls back past a scheduled post to one that is live", async () => {
        const live = await publish("Already Out", daysAgo(3));
        await publish("Not Yet", inDays(4));
        assert.equal((await getFeaturedPost(db()))?.slug, live.slug);
      });
    });

    it("is null when nothing is published at all", async () => {
      await createPost(db(), { title: "Only A Draft", status: "draft" });
      assert.equal(await getFeaturedPost(db()), null);
    });
  },
);
