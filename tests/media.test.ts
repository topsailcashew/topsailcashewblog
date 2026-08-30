import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  buildMediaKey,
  detectImageType,
  listMedia,
  uploadMedia,
} from "@/lib/media";
import { publicUrlForKey } from "@/lib/r2";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { db, hasDatabase, resetTables, setupDatabase, teardownDatabase } from "./helpers";

/** Minimal in-memory stand-in for the R2 binding. */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    bucket: {
      put: async (
        key: string,
        value: Uint8Array,
        options?: { httpMetadata?: { contentType?: string } },
      ) => {
        objects.set(key, {
          bytes: value,
          contentType: options?.httpMetadata?.contentType,
        });
        return null;
      },
    } as unknown as R2Bucket,
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = new Uint8Array([...Buffer.from("GIF89a"), 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
const AVIF = new Uint8Array([0, 0, 0, 0, ...Buffer.from("ftypavif")]);
const SVG = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

describe("image sniffing", () => {
  it("identifies the formats we accept from their magic bytes", () => {
    assert.equal(detectImageType(PNG)?.mime, "image/png");
    assert.equal(detectImageType(JPEG)?.mime, "image/jpeg");
    assert.equal(detectImageType(GIF)?.mime, "image/gif");
    assert.equal(detectImageType(WEBP)?.mime, "image/webp");
    assert.equal(detectImageType(AVIF)?.mime, "image/avif");
  });

  it("refuses SVG — it would be stored XSS on our own origin", () => {
    assert.equal(detectImageType(SVG), null);
  });

  it("refuses content that merely claims to be an image", () => {
    assert.equal(detectImageType(new Uint8Array(Buffer.from("not an image at all"))), null);
    assert.equal(detectImageType(new Uint8Array([1, 2, 3])), null);
  });
});

describe("media keys", () => {
  it("builds a dated, slugified, collision-resistant key", () => {
    const key = buildMediaKey("My Holiday Photo!.JPG", "jpg");
    assert.match(key, /^\d{4}\/\d{2}\/[0-9a-f]{8}-my-holiday-photo\.jpg$/);
  });

  it("survives a name with nothing usable in it", () => {
    assert.match(buildMediaKey("???.png", "png"), /^\d{4}\/\d{2}\/[0-9a-f]{8}\.png$/);
  });

  it("does not repeat a key for the same filename", () => {
    assert.notEqual(buildMediaKey("a.png", "png"), buildMediaKey("a.png", "png"));
  });
});

describe("public URLs", () => {
  it("serves through the Worker when no CDN base is configured", () => {
    delete process.env.R2_PUBLIC_BASE_URL;
    assert.equal(publicUrlForKey("2026/08/abc-x.png"), "/media/2026/08/abc-x.png");
  });

  it("uses the CDN base when one is set, without doubling the slash", () => {
    process.env.R2_PUBLIC_BASE_URL = "https://media.example.com/";
    assert.equal(
      publicUrlForKey("2026/08/abc-x.png"),
      "https://media.example.com/2026/08/abc-x.png",
    );
    delete process.env.R2_PUBLIC_BASE_URL;
  });
});

describe(
  "uploadMedia",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("stores the object and records the row", async () => {
      const { bucket, objects } = fakeBucket();
      const file = new File([PNG], "Diagram One.png", { type: "image/png" });

      const uploaded = await uploadMedia(db(), bucket, file, "A diagram");

      assert.match(uploaded.r2_key, /^\d{4}\/\d{2}\/[0-9a-f]{8}-diagram-one\.png$/);
      assert.equal(uploaded.url, `/media/${uploaded.r2_key}`);
      assert.equal(uploaded.alt_text, "A diagram");
      assert.equal(objects.get(uploaded.r2_key)?.contentType, "image/png");

      const rows = await listMedia(db());
      assert.equal(rows.length, 1);
      assert.equal(rows[0].r2_key, uploaded.r2_key);
    });

    it("trusts the bytes, not the declared Content-Type", async () => {
      const { bucket } = fakeBucket();
      // Claims to be a PNG; the body is plain text.
      const file = new File([Buffer.from("nope, just text here")], "x.png", {
        type: "image/png",
      });

      await assert.rejects(
        () => uploadMedia(db(), bucket, file, null),
        /Unsupported image format/,
      );
      assert.equal((await listMedia(db())).length, 0);
    });

    it("rejects an empty file", async () => {
      const { bucket } = fakeBucket();
      await assert.rejects(
        () => uploadMedia(db(), bucket, new File([], "empty.png"), null),
        /File is empty/,
      );
    });

    it("rejects a file over the size cap", async () => {
      const { bucket } = fakeBucket();
      const oversized = new File(
        [new Uint8Array(MAX_UPLOAD_BYTES + 1)],
        "huge.png",
        { type: "image/png" },
      );
      await assert.rejects(() => uploadMedia(db(), bucket, oversized, null), /the limit is/);
    });

    it("stores a null alt text rather than an empty string", async () => {
      const { bucket } = fakeBucket();
      const uploaded = await uploadMedia(
        db(),
        bucket,
        new File([JPEG], "photo.jpg", { type: "image/jpeg" }),
        null,
      );
      assert.equal(uploaded.alt_text, null);
    });
  },
);
