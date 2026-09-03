import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { PATCH as patchPost } from "@/app/api/posts/[id]/route";
import { posts } from "@/db/schema";
import { createPost } from "@/lib/posts";
import {
  getFeed,
  getPublishedPost,
  listPublishedForFeed,
  listPublishedSlugs,
  searchPublished,
} from "@/lib/public-posts";
import {
  bodyOf,
  ctx,
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + HOUR);
const past = () => new Date(Date.now() - HOUR);

async function seed(slug: string, publishedAt: Date) {
  const [row] = await db()
    .insert(posts)
    .values({
      title: slug,
      slug,
      contentHtml: "<p>Body.</p>",
      status: "published",
      publishedAt,
    })
    .returning();
  return row;
}

describe(
  "scheduled publishing",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("hides a post dated in the future from every public read", async () => {
      await seed("later", future());
      await seed("now", past());

      const feed = await getFeed(db(), 1);
      assert.deepEqual(
        feed.posts.map((post) => post.slug),
        ["now"],
      );
      assert.equal(feed.totalPosts, 1);

      // The post's own URL, the build manifest, the RSS list and search all
      // read through the same predicate — none of them may leak it early.
      assert.equal(await getPublishedPost(db(), "later"), null);
      assert.deepEqual(await listPublishedSlugs(db()), ["now"]);
      assert.deepEqual(
        (await listPublishedForFeed(db())).map((post) => post.slug),
        ["now"],
      );
      assert.deepEqual(
        (await searchPublished(db(), "later")).results.map((post) => post.slug),
        [],
      );
    });

    it("reveals the post once its time has passed, with no further write", async () => {
      const row = await seed("timed", future());
      assert.equal(await getPublishedPost(db(), "timed"), null);

      // Nothing publishes it — the clock does. Moving the stored date back is
      // the same thing as the wall clock moving forward.
      await db()
        .update(posts)
        .set({ publishedAt: past() })
        .where(eq(posts.id, row.id));

      const post = await getPublishedPost(db(), "timed");
      assert.equal(post?.slug, "timed");
    });

    it("accepts a publication date through the API and honours it", async () => {
      const created = await createPost(db(), { title: "Announcement" });
      const when = future().toISOString();

      const response = await patchPost(
        new NextRequest(`http://localhost/api/posts/${created.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "published", published_at: when }),
        }),
        ctx(created.id),
      );
      assert.equal(response.status, 200);

      const { post } = await bodyOf<{ post: { published_at: string; status: string } }>(
        response,
      );
      assert.equal(post.status, "published");
      assert.equal(new Date(post.published_at).toISOString(), when);

      // Published as far as the admin is concerned, invisible to a reader.
      assert.equal(await getPublishedPost(db(), created.slug), null);
    });

    it("clears a schedule when the date is set back to null", async () => {
      const created = await createPost(db(), {
        title: "Held",
        status: "published",
        published_at: future().toISOString(),
      });
      assert.equal(await getPublishedPost(db(), created.slug), null);

      const response = await patchPost(
        new NextRequest(`http://localhost/api/posts/${created.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ published_at: null }),
        }),
        ctx(created.id),
      );
      assert.equal(response.status, 200);

      // A published post with no date is not visible either: the comparison
      // `null <= now()` is NULL, not true. That is the honest outcome — the
      // admin sees an empty date and can fill one in.
      assert.equal(await getPublishedPost(db(), created.slug), null);
    });
  },
);
