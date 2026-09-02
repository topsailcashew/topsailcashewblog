import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  countMedia,
  deleteMedia,
  findMediaUsage,
  getMediaById,
  listMedia,
  setMediaAltText,
  uploadMedia,
} from "@/lib/media";
import { createPage, updatePage } from "@/lib/pages";
import { createPost, updatePost } from "@/lib/posts";
import { db, hasDatabase, resetTables, setupDatabase, teardownDatabase } from "./helpers";

/** In-memory R2 stand-in that also records deletes. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: Uint8Array) => {
        objects.set(key, value);
        return null;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    } as unknown as R2Bucket,
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const upload = (bucket: R2Bucket, name: string, alt: string | null = null) =>
  uploadMedia(db(), bucket, new File([PNG], name, { type: "image/png" }), alt);

describe(
  "media library",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("records the filename, type and size so the library is searchable", async () => {
      const { bucket } = fakeBucket();
      const item = await upload(bucket, "harbour-at-dusk.png", "The harbour");

      assert.equal(item.filename, "harbour-at-dusk.png");
      assert.equal(item.content_type, "image/png");
      assert.equal(item.size_bytes, PNG.byteLength);
      assert.equal(item.alt_text, "The harbour");
    });

    it("searches on filename and on alt text", async () => {
      const { bucket } = fakeBucket();
      await upload(bucket, "harbour.png", "Boats at dusk");
      await upload(bucket, "mountain.png", "A ridge line");

      assert.deepEqual(
        (await listMedia(db(), 50, { search: "harbour" })).map((m) => m.filename),
        ["harbour.png"],
      );
      // Matching alt text finds an image whose filename says nothing useful.
      assert.deepEqual(
        (await listMedia(db(), 50, { search: "ridge" })).map((m) => m.filename),
        ["mountain.png"],
      );
      assert.equal((await listMedia(db(), 50, { search: "nothing" })).length, 0);
      assert.equal(await countMedia(db()), 2);
    });

    it("paginates", async () => {
      const { bucket } = fakeBucket();
      for (const name of ["a.png", "b.png", "c.png"]) await upload(bucket, name);

      const firstTwo = await listMedia(db(), 2, {});
      const rest = await listMedia(db(), 2, { offset: 2 });
      assert.equal(firstTwo.length, 2);
      assert.equal(rest.length, 1);
    });

    it("edits alt text and clears it when blank", async () => {
      const { bucket } = fakeBucket();
      const item = await upload(bucket, "x.png", "Original");

      assert.equal((await setMediaAltText(db(), item.id, "Better")).alt_text, "Better");
      assert.equal((await setMediaAltText(db(), item.id, "   ")).alt_text, null);
    });

    describe("usage", () => {
      it("finds an image used as a cover", async () => {
        const { bucket } = fakeBucket();
        const item = await upload(bucket, "cover.png");
        const post = await createPost(db(), {
          title: "With a cover",
          cover_image_url: item.url,
        });

        const usage = await findMediaUsage(db(), item.url);
        assert.deepEqual(usage, [{ kind: "post", id: post.id, title: "With a cover" }]);
      });

      it("finds an image embedded in body HTML", async () => {
        const { bucket } = fakeBucket();
        const item = await upload(bucket, "inline.png");
        const post = await createPost(db(), { title: "Inline" });
        await updatePost(db(), post.id, {
          content_html: `<p>Text</p><img src="${item.url}" alt=""><p>More</p>`,
        });

        const usage = await findMediaUsage(db(), item.url);
        assert.deepEqual(usage.map((u) => u.id), [post.id]);
      });

      it("finds an image used on a page", async () => {
        const { bucket } = fakeBucket();
        const item = await upload(bucket, "onpage.png");
        const page = await createPage(db(), { title: "About" });
        await updatePage(db(), page.id, {
          content_html: `<img src="${item.url}" alt="">`,
        });

        const usage = await findMediaUsage(db(), item.url);
        assert.deepEqual(usage, [{ kind: "page", id: page.id, title: "About" }]);
      });

      it("reports nothing for an unused image", async () => {
        const { bucket } = fakeBucket();
        const item = await upload(bucket, "orphan.png");
        assert.deepEqual(await findMediaUsage(db(), item.url), []);
      });

      it("does not mistake one image for another with a shared prefix", async () => {
        const { bucket } = fakeBucket();
        const a = await upload(bucket, "photo.png");
        const b = await upload(bucket, "photo.png");
        // Keys are unique per upload, so a post using one must not report the
        // other as used.
        await createPost(db(), { title: "Uses A", cover_image_url: a.url });

        assert.equal((await findMediaUsage(db(), a.url)).length, 1);
        assert.equal((await findMediaUsage(db(), b.url)).length, 0);
      });
    });

    it("deletes the row and the object together", async () => {
      const { bucket, objects } = fakeBucket();
      const item = await upload(bucket, "gone.png");
      assert.equal(objects.has(item.r2_key), true);

      await deleteMedia(db(), bucket, item.id);

      assert.equal(await getMediaById(db(), item.id), null);
      assert.equal(objects.has(item.r2_key), false);
    });

    it("still removes the row when the object is already gone from R2", async () => {
      const { bucket } = fakeBucket();
      const item = await upload(bucket, "vanished.png");

      const failing = {
        put: bucket.put.bind(bucket),
        delete: async () => {
          throw new Error("R2 unavailable");
        },
      } as unknown as R2Bucket;

      // A row pointing at a missing object is a broken image; an orphaned
      // object is only wasted bytes. The delete must not be left half-done in
      // the direction that breaks a page.
      await deleteMedia(db(), failing, item.id);
      assert.equal(await getMediaById(db(), item.id), null);
    });
  },
);
