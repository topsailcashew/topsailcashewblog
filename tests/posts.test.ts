import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { posts as postsTable } from "@/db/schema";
import { isUniqueViolation } from "@/lib/slug";
import { GET as listPosts, POST as createPost } from "@/app/api/posts/route";
import {
  DELETE as deletePost,
  GET as getPost,
  PATCH as patchPost,
} from "@/app/api/posts/[id]/route";
import type { SerializedPost } from "@/lib/posts";
import {
  bodyOf,
  ctx,
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

const BASE = "http://localhost:3000";

function post(body: unknown) {
  return new NextRequest(`${BASE}/api/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(id: string, body: unknown) {
  return new NextRequest(`${BASE}/api/posts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function list(query = "") {
  return new NextRequest(`${BASE}/api/posts${query}`);
}

async function create(body: unknown): Promise<SerializedPost> {
  const response = await createPost(post(body));
  assert.equal(response.status, 201, await response.clone().text());
  const { post: created } = await bodyOf<{ post: SerializedPost }>(response);
  return created;
}

describe("posts API", { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" }, () => {
  before(setupDatabase);
  after(teardownDatabase);
  beforeEach(resetTables);

  describe("POST /api/posts", () => {
    it("creates a draft and derives the slug from the title", async () => {
      const created = await create({ title: "Hello, World! A Beginning" });

      assert.equal(created.status, "draft");
      assert.equal(created.slug, "hello-world-a-beginning");
      assert.equal(created.published_at, null);
      assert.deepEqual(created.tags, []);
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.ok(Date.parse(created.created_at) > 0);
    });

    it("appends -2, -3 on slug collision", async () => {
      const first = await create({ title: "Same Title" });
      const second = await create({ title: "Same Title" });
      const third = await create({ title: "Same Title" });

      assert.equal(first.slug, "same-title");
      assert.equal(second.slug, "same-title-2");
      assert.equal(third.slug, "same-title-3");
    });

    it("folds accents and drops punctuation when slugifying", async () => {
      const created = await create({ title: "Café — Naïve Résumé?!" });
      assert.equal(created.slug, "cafe-naive-resume");
    });

    it("stamps published_at when created directly as published", async () => {
      const created = await create({ title: "Live now", status: "published" });
      assert.equal(created.status, "published");
      assert.ok(created.published_at !== null);
    });

    it("stores the Tiptap document and attaches tags", async () => {
      const doc = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      };
      const created = await create({
        title: "With content",
        content_json: doc,
        excerpt: "A short excerpt",
        cover_image_url: "https://example.com/cover.jpg",
        tags: ["Web Design", "TypeScript"],
      });

      assert.deepEqual(created.content_json, doc);
      assert.equal(created.excerpt, "A short excerpt");
      assert.equal(created.cover_image_url, "https://example.com/cover.jpg");
      assert.deepEqual(
        created.tags.map((tag) => tag.slug).sort(),
        ["typescript", "web-design"],
      );
    });

    it("rejects a missing title with 422", async () => {
      const response = await createPost(post({ excerpt: "no title" }));
      assert.equal(response.status, 422);
      const body = await bodyOf<{ error: string; details: Record<string, string[]> }>(
        response,
      );
      assert.equal(body.error, "Validation failed");
      assert.ok(body.details.title);
    });

    it("rejects a malformed JSON body with 400", async () => {
      const response = await createPost(
        new NextRequest(`${BASE}/api/posts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{ not json",
        }),
      );
      assert.equal(response.status, 400);
    });
  });

  describe("GET /api/posts", () => {
    it("lists posts newest first and filters by status", async () => {
      await create({ title: "Draft one" });
      await create({ title: "Published one", status: "published" });
      await create({ title: "Draft two" });

      const all = await bodyOf<{ posts: SerializedPost[] }>(await listPosts(list()));
      assert.equal(all.posts.length, 3);

      const drafts = await bodyOf<{ posts: SerializedPost[] }>(
        await listPosts(list("?status=draft")),
      );
      assert.deepEqual(
        drafts.posts.map((p) => p.title),
        ["Draft two", "Draft one"],
      );

      const published = await bodyOf<{ posts: SerializedPost[] }>(
        await listPosts(list("?status=published")),
      );
      assert.deepEqual(
        published.posts.map((p) => p.title),
        ["Published one"],
      );
    });

    it("honours limit and offset", async () => {
      for (const title of ["A", "B", "C"]) await create({ title });

      const page = await bodyOf<{ posts: SerializedPost[]; limit: number }>(
        await listPosts(list("?limit=2")),
      );
      assert.equal(page.posts.length, 2);
      assert.equal(page.limit, 2);

      const second = await bodyOf<{ posts: SerializedPost[] }>(
        await listPosts(list("?limit=2&offset=2")),
      );
      assert.equal(second.posts.length, 1);
    });

    it("rejects an unknown status with 422", async () => {
      const response = await listPosts(list("?status=archived"));
      assert.equal(response.status, 422);
    });

    it("includes tags on listed posts", async () => {
      await create({ title: "Tagged", tags: ["Essays"] });
      const body = await bodyOf<{ posts: SerializedPost[] }>(await listPosts(list()));
      assert.deepEqual(body.posts[0].tags.map((t) => t.name), ["Essays"]);
    });
  });

  describe("GET /api/posts/:id", () => {
    it("returns a single post", async () => {
      const created = await create({ title: "Find me", tags: ["Notes"] });
      const response = await getPost(
        new NextRequest(`${BASE}/api/posts/${created.id}`),
        ctx(created.id),
      );
      assert.equal(response.status, 200);
      const { post: found } = await bodyOf<{ post: SerializedPost }>(response);
      assert.equal(found.id, created.id);
      assert.deepEqual(found.tags.map((t) => t.slug), ["notes"]);
    });

    it("404s for an unknown id", async () => {
      const missing = "11111111-1111-4111-8111-111111111111";
      const response = await getPost(
        new NextRequest(`${BASE}/api/posts/${missing}`),
        ctx(missing),
      );
      assert.equal(response.status, 404);
    });

    it("422s for an id that is not a uuid", async () => {
      const response = await getPost(
        new NextRequest(`${BASE}/api/posts/not-a-uuid`),
        ctx("not-a-uuid"),
      );
      assert.equal(response.status, 422);
    });
  });

  describe("PATCH /api/posts/:id", () => {
    it("updates only the fields provided", async () => {
      const created = await create({
        title: "Original",
        excerpt: "Original excerpt",
      });

      const response = await patchPost(
        patch(created.id, { title: "Rewritten" }),
        ctx(created.id),
      );
      assert.equal(response.status, 200);
      const { post: updated } = await bodyOf<{ post: SerializedPost }>(response);

      assert.equal(updated.title, "Rewritten");
      assert.equal(updated.excerpt, "Original excerpt");
      // Editing the title must not break the permalink.
      assert.equal(updated.slug, "original");
      assert.ok(Date.parse(updated.updated_at) >= Date.parse(created.updated_at));
    });

    it("accepts an explicit slug override and keeps it unique", async () => {
      await create({ title: "Taken" });
      const created = await create({ title: "Movable" });

      const { post: renamed } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(patch(created.id, { slug: "brand-new" }), ctx(created.id)),
      );
      assert.equal(renamed.slug, "brand-new");

      const { post: collided } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(patch(created.id, { slug: "taken" }), ctx(created.id)),
      );
      assert.equal(collided.slug, "taken-2");
    });

    it("rejects a malformed slug with 422", async () => {
      const created = await create({ title: "Slug rules" });
      const response = await patchPost(
        patch(created.id, { slug: "Not A Slug" }),
        ctx(created.id),
      );
      assert.equal(response.status, 422);
    });

    it("stamps published_at on first publish and preserves it afterwards", async () => {
      const created = await create({ title: "Publish flow" });
      assert.equal(created.published_at, null);

      const { post: published } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(patch(created.id, { status: "published" }), ctx(created.id)),
      );
      assert.equal(published.status, "published");
      assert.ok(published.published_at !== null);

      const { post: unpublished } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(patch(created.id, { status: "draft" }), ctx(created.id)),
      );
      assert.equal(unpublished.status, "draft");
      assert.equal(unpublished.published_at, published.published_at);

      const { post: republished } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(patch(created.id, { status: "published" }), ctx(created.id)),
      );
      assert.equal(republished.published_at, published.published_at);
    });

    it("creates missing tags, reuses existing ones, and replaces the set", async () => {
      const first = await create({ title: "Tag owner", tags: ["Design"] });
      const second = await create({ title: "Tag borrower" });

      const { post: tagged } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(
          patch(second.id, { tags: ["design", "Engineering"] }),
          ctx(second.id),
        ),
      );
      assert.deepEqual(
        tagged.tags.map((t) => t.slug).sort(),
        ["design", "engineering"],
      );
      // "design" resolved to the existing tag rather than creating a second one.
      assert.equal(
        tagged.tags.find((t) => t.slug === "design")?.id,
        first.tags[0].id,
      );

      const { post: retagged } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(patch(second.id, { tags: ["Engineering"] }), ctx(second.id)),
      );
      assert.deepEqual(retagged.tags.map((t) => t.slug), ["engineering"]);

      const { post: cleared } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(patch(second.id, { tags: [] }), ctx(second.id)),
      );
      assert.deepEqual(cleared.tags, []);
    });

    it("preserves tags when the patch does not mention them", async () => {
      const created = await create({ title: "Keeps tags", tags: ["Essays"] });
      const { post: updated } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(patch(created.id, { excerpt: "new" }), ctx(created.id)),
      );
      assert.deepEqual(updated.tags.map((t) => t.slug), ["essays"]);
    });

    it("clears nullable fields when passed null", async () => {
      const created = await create({
        title: "Clearable",
        excerpt: "something",
        cover_image_url: "https://example.com/a.jpg",
      });
      const { post: updated } = await bodyOf<{ post: SerializedPost }>(
        await patchPost(
          patch(created.id, { excerpt: null, cover_image_url: null }),
          ctx(created.id),
        ),
      );
      assert.equal(updated.excerpt, null);
      assert.equal(updated.cover_image_url, null);
    });

    it("404s when the post does not exist", async () => {
      const missing = "22222222-2222-4222-8222-222222222222";
      const response = await patchPost(patch(missing, { title: "ghost" }), ctx(missing));
      assert.equal(response.status, 404);
    });

    it("rejects an empty patch with 422", async () => {
      const created = await create({ title: "No-op" });
      const response = await patchPost(patch(created.id, {}), ctx(created.id));
      assert.equal(response.status, 422);
    });
  });

  describe("cover_image_url", () => {
    it("accepts the site-relative path an R2 upload returns", async () => {
      const created = await create({
        title: "With a cover",
        cover_image_url: "/media/2026/08/abc12345-cover.png",
      });
      assert.equal(created.cover_image_url, "/media/2026/08/abc12345-cover.png");
    });

    it("accepts an absolute CDN URL", async () => {
      const created = await create({
        title: "CDN cover",
        cover_image_url: "https://media.example.com/2026/08/x.png",
      });
      assert.equal(created.cover_image_url, "https://media.example.com/2026/08/x.png");
    });

    it("rejects a protocol-relative URL that would point off-site", async () => {
      const response = await createPost(
        post({ title: "Sneaky", cover_image_url: "//evil.example/x.png" }),
      );
      assert.equal(response.status, 422);
    });

    it("rejects a javascript: URL", async () => {
      const response = await createPost(
        post({ title: "Sneaky 2", cover_image_url: "javascript:alert(1)" }),
      );
      assert.equal(response.status, 422);
    });
  });

  describe("slug uniqueness", () => {
    it("detects a unique violation through Drizzle's error wrapping", async () => {
      // Guards the retry inside withUniqueSlug: if the SQLSTATE stops being
      // visible, a concurrent slug collision becomes a 500 instead of a -2.
      await db().insert(postsTable).values({ title: "First", slug: "clash" });
      const error = await db()
        .insert(postsTable)
        .values({ title: "Second", slug: "clash" })
        .then(
          () => null,
          (caught: unknown) => caught,
        );

      assert.ok(error !== null, "expected the duplicate insert to fail");
      assert.ok(isUniqueViolation(error), "SQLSTATE 23505 was not detected");
    });
  });

  describe("DELETE /api/posts/:id", () => {
    it("moves the post to the trash and out of the list", async () => {
      const created = await create({ title: "Temporary", tags: ["Ephemera"] });

      const response = await deletePost(
        new NextRequest(`${BASE}/api/posts/${created.id}`, { method: "DELETE" }),
        ctx(created.id),
      );
      assert.equal(response.status, 204);

      // The row survives — that is the point of the trash — but nothing that
      // lists posts should show it.
      const after = await getPost(
        new NextRequest(`${BASE}/api/posts/${created.id}`),
        ctx(created.id),
      );
      assert.equal(after.status, 200);
      const { post } = await bodyOf<{ post: SerializedPost }>(after);
      assert.ok(post.deleted_at !== null);
      assert.deepEqual(post.tags.map((tag) => tag.name), ["Ephemera"]);

      const remaining = await bodyOf<{ posts: SerializedPost[] }>(
        await listPosts(list()),
      );
      assert.equal(remaining.posts.length, 0);
    });

    it("deletes for good with ?permanent=1", async () => {
      const created = await create({ title: "Temporary", tags: ["Ephemera"] });

      const response = await deletePost(
        new NextRequest(`${BASE}/api/posts/${created.id}?permanent=1`, {
          method: "DELETE",
        }),
        ctx(created.id),
      );
      assert.equal(response.status, 204);

      const after = await getPost(
        new NextRequest(`${BASE}/api/posts/${created.id}`),
        ctx(created.id),
      );
      assert.equal(after.status, 404);
    });

    it("404s when the post does not exist", async () => {
      const missing = "33333333-3333-4333-8333-333333333333";
      const response = await deletePost(
        new NextRequest(`${BASE}/api/posts/${missing}`, { method: "DELETE" }),
        ctx(missing),
      );
      assert.equal(response.status, 404);
    });
  });
});
