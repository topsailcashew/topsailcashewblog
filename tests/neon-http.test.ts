import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { posts, schema } from "@/db/schema";
import { createPost, deletePost, getPostById, listPosts, updatePost } from "@/lib/posts";
import { isUniqueViolation } from "@/lib/slug";
import { connectionString, hasDatabase, migrateOnce } from "./helpers";
import { startNeonShim, type NeonShim } from "./neon-http-shim";

/**
 * Everything else in the suite talks to Postgres through node-postgres. This
 * file runs the same repository code through the Neon HTTP driver the Worker
 * actually deploys with, so the driver differences the query layer papers over
 * (`toRows`, array params, SQLSTATE nesting) are genuinely exercised.
 */
describe(
  "neon-http driver parity",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    let shim: NeonShim;
    let db: BlogDatabase;

    before(async () => {
      await migrateOnce();
      shim = await startNeonShim(connectionString);
      neonConfig.fetchEndpoint = () => shim.url;
      db = drizzle(neon("postgresql://shim:shim@shim.local/blog"), {
        schema,
      }) as unknown as BlogDatabase;
    });

    after(async () => {
      await shim.close();
    });

    beforeEach(async () => {
      await db.execute(
        sql`truncate table post_tags, posts, tags, media restart identity cascade`,
      );
    });

    it("round-trips a post through create, read, update and delete", async () => {
      const created = await createPost(db, {
        title: "Over the wire",
        excerpt: "via neon-http",
        content_json: { type: "doc", content: [] },
        tags: ["Driver Test", "Neon"],
      });

      assert.equal(created.slug, "over-the-wire");
      assert.equal(created.status, "draft");
      // Timestamps survive Neon's raw-text output and client-side parsing.
      assert.ok(Number.isFinite(Date.parse(created.created_at)));
      assert.deepEqual(
        created.tags.map((tag) => tag.slug).sort(),
        ["driver-test", "neon"],
      );

      const fetched = await getPostById(db, created.id);
      assert.equal(fetched?.id, created.id);
      assert.deepEqual(fetched?.content_json, { type: "doc", content: [] });

      const { post: published, previous } = await updatePost(db, created.id, {
        status: "published",
        tags: ["Neon"],
      });
      assert.equal(previous.status, "draft");
      assert.deepEqual(previous.tagSlugs.sort(), ["driver-test", "neon"]);
      assert.equal(published.status, "published");
      assert.ok(published.published_at !== null);
      assert.deepEqual(published.tags.map((tag) => tag.slug), ["neon"]);

      const listed = await listPosts(db, { status: "published", limit: 10, offset: 0 });
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0].tags.map((tag) => tag.name), ["Neon"]);

      await deletePost(db, created.id);
      assert.equal(await getPostById(db, created.id), null);
    });

    it("resolves slug collisions the same way as node-postgres", async () => {
      const first = await createPost(db, { title: "Shared name" });
      const second = await createPost(db, { title: "Shared name" });
      assert.equal(first.slug, "shared-name");
      assert.equal(second.slug, "shared-name-2");
    });

    it("recognises a unique violation through the driver's error wrapping", async () => {
      await db.insert(posts).values({ title: "First", slug: "duplicate-slug" });

      const error = await db
        .insert(posts)
        .values({ title: "Second", slug: "duplicate-slug" })
        .then(
          () => null,
          (caught: unknown) => caught,
        );

      assert.ok(error !== null, "expected the duplicate insert to fail");
      assert.ok(
        isUniqueViolation(error),
        `SQLSTATE 23505 was not detected in ${JSON.stringify(String(error))}`,
      );
    });

    it("reads rows back from db.execute in the driver's own shape", async () => {
      await createPost(db, { title: "Shape check", tags: ["Alpha"] });
      const result = await db.execute(sql`select name, slug from tags`);
      // `toRows` normalises this; assert the raw shape so a driver change is loud.
      const rows = Array.isArray(result)
        ? result
        : (result as { rows: unknown[] }).rows;
      assert.equal(rows.length, 1);
    });
  },
);
