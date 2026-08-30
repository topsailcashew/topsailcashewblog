import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { POST as submitRoute } from "@/app/api/comments/route";
import { comments, posts } from "@/db/schema";
import {
  countRecentFrom,
  getApprovedThread,
  listForModeration,
  rateLimitPerHour,
  replyAsAuthor,
  setCommentStatus,
  submitComment,
} from "@/lib/comments";
import { db, hasDatabase, resetTables, setupDatabase, teardownDatabase } from "./helpers";

async function seedPost(slug = "host-post", status: "draft" | "published" = "published") {
  const [row] = await db()
    .insert(posts)
    .values({
      title: `Post ${slug}`,
      slug,
      contentHtml: "<p>Body.</p>",
      status,
      publishedAt: status === "published" ? new Date() : null,
    })
    .returning();
  return row;
}

function submitRequest(body: unknown, ip = "203.0.113.1") {
  return new NextRequest("http://localhost/api/comments", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

describe(
  "comments",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(async () => {
      await setupDatabase();
      process.env.SESSION_SECRET ??= "comment-test-secret-0123456789";
    });
    after(teardownDatabase);
    beforeEach(resetTables);

    describe("what the public can see", () => {
      it("shows approved comments and hides every other status", async () => {
        const post = await seedPost();
        for (const status of ["pending", "approved", "rejected", "spam"] as const) {
          await db().insert(comments).values({
            postId: post.id,
            authorName: status,
            authorEmail: `${status}@example.com`,
            body: `${status} body`,
            status,
          });
        }

        const thread = await getApprovedThread(db(), post.id);
        assert.deepEqual(thread.map((c) => c.author_name), ["approved"]);
      });

      it("never exposes an email address in the public shape", async () => {
        const post = await seedPost();
        await db().insert(comments).values({
          postId: post.id,
          authorName: "Reader",
          authorEmail: "private@example.com",
          body: "Hello",
          status: "approved",
        });

        const thread = await getApprovedThread(db(), post.id);
        assert.ok(!JSON.stringify(thread).includes("private@example.com"));
        assert.ok(!("author_email" in thread[0]));
      });

      it("nests replies exactly one level under their parent", async () => {
        const post = await seedPost();
        const [parent] = await db().insert(comments).values({
          postId: post.id, authorName: "Top", authorEmail: "t@example.com",
          body: "Top level", status: "approved",
        }).returning();
        await db().insert(comments).values({
          postId: post.id, parentId: parent.id, authorName: "Reply",
          authorEmail: "r@example.com", body: "A reply", status: "approved",
        });

        const thread = await getApprovedThread(db(), post.id);
        assert.equal(thread.length, 1);
        assert.equal(thread[0].replies.length, 1);
        assert.equal(thread[0].replies[0].replies.length, 0);
      });

      it("promotes an approved reply whose parent was hidden", async () => {
        const post = await seedPost();
        const [parent] = await db().insert(comments).values({
          postId: post.id, authorName: "Spammy", authorEmail: "s@example.com",
          body: "Spam parent", status: "spam",
        }).returning();
        await db().insert(comments).values({
          postId: post.id, parentId: parent.id, authorName: "Innocent",
          authorEmail: "i@example.com", body: "Legit reply", status: "approved",
        });

        const thread = await getApprovedThread(db(), post.id);
        // Visible on its own merit rather than disappearing with its parent.
        assert.deepEqual(thread.map((c) => c.author_name), ["Innocent"]);
      });
    });

    describe("submission", () => {
      it("lands as pending, not approved", async () => {
        const post = await seedPost();
        const response = await submitRoute(
          submitRequest({
            post_id: post.id,
            author_name: "Reader",
            author_email: "reader@example.com",
            body: "A perfectly reasonable comment.",
          }),
        );

        assert.equal(response.status, 202);
        const rows = await listForModeration(db());
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "pending");
        assert.deepEqual(await getApprovedThread(db(), post.id), []);
      });

      it("accepts a filled honeypot without storing anything", async () => {
        const post = await seedPost();
        const response = await submitRoute(
          submitRequest({
            post_id: post.id,
            author_name: "Bot",
            author_email: "bot@example.com",
            body: "Buy things.",
            website: "http://spam.example",
          }),
        );

        // Indistinguishable from a real submission, so a bot learns nothing.
        assert.equal(response.status, 202);
        assert.equal((await listForModeration(db())).length, 0);
      });

      it("refuses to take comments on a draft", async () => {
        const draft = await seedPost("hidden-draft", "draft");
        const response = await submitRoute(
          submitRequest({
            post_id: draft.id,
            author_name: "Reader",
            author_email: "reader@example.com",
            body: "Can I comment on a draft?",
          }),
        );
        assert.equal(response.status, 404);
        assert.equal((await listForModeration(db())).length, 0);
      });

      it("stops a flood from one address but not from another", async () => {
        const post = await seedPost();
        const limit = rateLimitPerHour();

        for (let i = 0; i < limit; i += 1) {
          const ok = await submitRoute(
            submitRequest({
              post_id: post.id,
              author_name: `Flood ${i}`,
              author_email: "flood@example.com",
              body: `Attempt number ${i} with enough text.`,
            }),
          );
          assert.equal(ok.status, 202, `submission ${i} should be accepted`);
        }

        const blocked = await submitRoute(
          submitRequest({
            post_id: post.id,
            author_name: "Flood extra",
            author_email: "flood@example.com",
            body: "One too many.",
          }),
        );
        assert.equal(blocked.status, 429);

        const other = await submitRoute(
          submitRequest(
            {
              post_id: post.id,
              author_name: "Someone else",
              author_email: "other@example.com",
              body: "Unrelated address.",
            },
            "198.51.100.42",
          ),
        );
        assert.equal(other.status, 202);
      });

      it("stores a hash of the address, never the address itself", async () => {
        const post = await seedPost();
        await submitRoute(
          submitRequest(
            {
              post_id: post.id,
              author_name: "Reader",
              author_email: "reader@example.com",
              body: "Something worth saying.",
            },
            "203.0.113.77",
          ),
        );

        const [row] = await db().select().from(comments);
        assert.ok(row.authorIpHash, "no fingerprint was stored");
        assert.ok(
          !row.authorIpHash.includes("203.0.113.77"),
          "the raw address reached the database",
        );
        assert.ok(await countRecentFrom(db(), row.authorIpHash) > 0);
      });

      it("flattens a reply aimed at a reply", async () => {
        const post = await seedPost();
        const [top] = await db().insert(comments).values({
          postId: post.id, authorName: "Top", authorEmail: "t@example.com",
          body: "Top", status: "approved",
        }).returning();
        const [mid] = await db().insert(comments).values({
          postId: post.id, parentId: top.id, authorName: "Mid",
          authorEmail: "m@example.com", body: "Mid", status: "approved",
        }).returning();

        await submitComment(db(), {
          postId: post.id,
          parentId: mid.id,
          authorName: "Deep",
          authorEmail: "d@example.com",
          body: "Aimed at the reply.",
          ipHash: null,
        });

        const [stored] = await db()
          .select()
          .from(comments)
          .where(eq(comments.body, "Aimed at the reply."));
        assert.equal(stored.parentId, top.id, "should re-parent to the top level");
      });
    });

    describe("moderation", () => {
      it("approving makes it public; spam takes it away again", async () => {
        const post = await seedPost();
        const { id } = await submitComment(db(), {
          postId: post.id,
          authorName: "Reader",
          authorEmail: "reader@example.com",
          body: "Worth approving.",
          ipHash: null,
        });

        assert.deepEqual(await getApprovedThread(db(), post.id), []);
        await setCommentStatus(db(), id, "approved");
        assert.equal((await getApprovedThread(db(), post.id)).length, 1);
        await setCommentStatus(db(), id, "spam");
        assert.deepEqual(await getApprovedThread(db(), post.id), []);
      });

      it("keeps rejected and spam visible to the moderator", async () => {
        const post = await seedPost();
        const { id } = await submitComment(db(), {
          postId: post.id, authorName: "Reader", authorEmail: "r@example.com",
          body: "Rejected later.", ipHash: null,
        });
        await setCommentStatus(db(), id, "rejected");

        const rejected = await listForModeration(db(), "rejected");
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].author_email, "r@example.com");
        assert.ok(rejected[0].post, "moderation view needs the post context");
      });

      it("an author reply is approved on the spot and badged", async () => {
        const post = await seedPost();
        const [parent] = await db().insert(comments).values({
          postId: post.id, authorName: "Reader", authorEmail: "r@example.com",
          body: "A question", status: "approved",
        }).returning();

        const reply = await replyAsAuthor(db(), {
          parentId: parent.id,
          authorName: "The Author",
          body: "An answer.",
        });

        assert.equal(reply.status, "approved");
        assert.equal(reply.is_author, true);

        const thread = await getApprovedThread(db(), post.id);
        assert.equal(thread[0].replies[0].is_author, true);
      });
    });
  },
);
