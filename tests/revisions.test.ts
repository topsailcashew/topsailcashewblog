import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import {
  GET as listRevisionsRoute,
  POST as restoreRoute,
} from "@/app/api/posts/[id]/revisions/route";
import { createPost, getPostById, updatePost } from "@/lib/posts";
import {
  MAX_REVISIONS_PER_POST,
  listRevisions,
  snapshotPost,
} from "@/lib/revisions";
import { renderTiptapHtml } from "@/lib/tiptap-html";
import {
  bodyOf,
  ctx,
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";
import { postRevisions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Backdates every snapshot so the one-hour throttle no longer applies. */
async function ageSnapshots(postId: string) {
  await db()
    .update(postRevisions)
    .set({ createdAt: sql`${postRevisions.createdAt} - interval '2 hours'` })
    .where(eq(postRevisions.postId, postId));
}

describe(
  "post revisions",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("does not snapshot every autosave", async () => {
      const post = await createPost(db(), { title: "Draft", content_json: doc("one") });

      // Ten seconds apart in the editor; here, back to back.
      for (const text of ["two", "three", "four", "five"]) {
        await updatePost(db(), post.id, { content_json: doc(text) });
      }

      // The first edit snapshots (nothing to throttle against); the rest fall
      // inside the hour window. This is the whole point of the design — the
      // WordPress default would have left five rows here.
      const revisions = await listRevisions(db(), post.id);
      assert.equal(revisions.length, 1);
      assert.equal(revisions[0].reason, "edit");
    });

    it("snapshots a publish transition regardless of the throttle", async () => {
      const post = await createPost(db(), { title: "Essay", content_json: doc("a") });
      // An edit first, so the throttle window is open and would block an
      // ordinary edit from snapshotting.
      await updatePost(db(), post.id, { content_json: doc("b") });
      await updatePost(db(), post.id, { content_json: doc("c"), status: "published" });
      await updatePost(db(), post.id, { content_json: doc("d"), status: "draft" });

      const reasons = (await listRevisions(db(), post.id)).map((r) => r.reason);
      // Newest first. The publish and unpublish both snapshot despite landing
      // well inside the hour the "edit" reason would have been throttled by.
      assert.deepEqual(reasons, ["unpublish", "publish", "edit"]);
    });

    it("stores one row when two moments hold identical text", async () => {
      const post = await createPost(db(), { title: "Steady", content_json: doc("a") });
      // Publish, then unpublish, without touching a word in between.
      await updatePost(db(), post.id, { status: "published" });
      await updatePost(db(), post.id, { status: "draft" });

      // The second snapshot would be a duplicate of the first with a different
      // label — the list tracks versions of the text, not a change log.
      const revisions = await listRevisions(db(), post.id);
      assert.equal(revisions.length, 1);
      assert.equal(revisions[0].reason, "publish");
    });

    it("skips a snapshot when nothing actually changed", async () => {
      const post = await createPost(db(), { title: "Same", content_json: doc("x") });
      await snapshotPost(db(), post.id, "edit");
      await ageSnapshots(post.id);

      // Past the throttle, but the content is identical — still no second row.
      await snapshotPost(db(), post.id, "edit");
      assert.equal((await listRevisions(db(), post.id)).length, 1);
    });

    it("snapshots again once the throttle window has passed", async () => {
      const post = await createPost(db(), { title: "Long session", content_json: doc("1") });
      await updatePost(db(), post.id, { content_json: doc("2") });
      await ageSnapshots(post.id);
      await updatePost(db(), post.id, { content_json: doc("3") });

      assert.equal((await listRevisions(db(), post.id)).length, 2);
    });

    it("keeps only the newest MAX_REVISIONS_PER_POST", async () => {
      const post = await createPost(db(), { title: "Prolific", content_json: doc("0") });

      for (let i = 1; i <= MAX_REVISIONS_PER_POST + 5; i += 1) {
        await updatePost(db(), post.id, { content_json: doc(`v${i}`) });
        await ageSnapshots(post.id);
      }

      const revisions = await listRevisions(db(), post.id);
      assert.equal(revisions.length, MAX_REVISIONS_PER_POST);
    });

    it("restores an earlier version and re-derives its HTML", async () => {
      const post = await createPost(db(), {
        title: "First title",
        content_json: doc("original words"),
        content_html: "<p>original words</p>",
      });
      await updatePost(db(), post.id, {
        title: "Second title",
        content_json: doc("replacement"),
        content_html: "<p>replacement</p>",
      });

      const [snapshot] = await listRevisions(db(), post.id);
      const response = await restoreRoute(
        new NextRequest(`http://localhost/api/posts/${post.id}/revisions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision_id: snapshot.id }),
        }),
        ctx(post.id),
      );
      assert.equal(response.status, 200);

      const restored = await getPostById(db(), post.id);
      assert.equal(restored?.title, "First title");
      // content_html is not stored on the revision; it is rebuilt from the JSON.
      assert.equal(restored?.content_html, "<p>original words</p>");
    });

    it("refuses a revision belonging to a different post", async () => {
      const mine = await createPost(db(), { title: "Mine", content_json: doc("m") });
      const theirs = await createPost(db(), { title: "Theirs", content_json: doc("t") });
      await updatePost(db(), theirs.id, { content_json: doc("t2") });

      const [foreign] = await listRevisions(db(), theirs.id);
      const response = await restoreRoute(
        new NextRequest(`http://localhost/api/posts/${mine.id}/revisions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision_id: foreign.id }),
        }),
        ctx(mine.id),
      );

      assert.equal(response.status, 404);
      assert.equal((await getPostById(db(), mine.id))?.title, "Mine");
    });

    it("lists snapshots newest first over the API", async () => {
      const post = await createPost(db(), { title: "Listed", content_json: doc("a") });
      await updatePost(db(), post.id, { status: "published" });

      const response = await listRevisionsRoute(
        new NextRequest(`http://localhost/api/posts/${post.id}/revisions`),
        ctx(post.id),
      );
      const { revisions } = await bodyOf<{ revisions: { title: string }[] }>(response);
      assert.equal(revisions.length, 1);
      assert.equal(revisions[0].title, "Listed");
    });
  },
);

describe("tiptap html rendering", () => {
  it("round-trips the node types the editor can produce", () => {
    const html = renderTiptapHtml({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Head" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] },
          ],
        },
      ],
    });

    assert.match(html, /<h2>Head<\/h2>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<a href="https:\/\/example\.com"/);
    assert.match(html, /<ul><li><p>item<\/p><\/li><\/ul>/);
  });

  it("drops a javascript: link rather than emitting it", () => {
    const html = renderTiptapHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    });

    assert.equal(html, "<p>click</p>");
    assert.doesNotMatch(html, /javascript:/);
  });

  it("escapes text that would otherwise close a tag", () => {
    const html = renderTiptapHtml({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "<script>x</script>" }] },
      ],
    });
    assert.equal(html, "<p>&lt;script&gt;x&lt;/script&gt;</p>");
  });

  it("drops a node type the editor's schema does not admit", () => {
    const html = renderTiptapHtml({
      type: "doc",
      content: [{ type: "rawHtml", attrs: { html: "<iframe src='evil'></iframe>" } }],
    });
    assert.equal(html, "");
  });
});
