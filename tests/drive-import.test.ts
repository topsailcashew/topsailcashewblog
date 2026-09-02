import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { posts } from "@/db/schema";
import { importFromDrive } from "@/lib/drive-import";
import type { DriveClient, DriveFile, DriveListing } from "@/lib/google-drive";
import { getPostById, updatePost } from "@/lib/posts";
import { getFeed, getPublishedPost } from "@/lib/public-posts";
import { db, hasDatabase, resetTables, setupDatabase, teardownDatabase } from "./helpers";

/** An in-memory Drive folder. */
function stubDrive(
  files: (Partial<DriveFile> & { id: string; name: string; body: string })[],
  extra: Partial<DriveListing> = {},
): DriveClient & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async listFolder(): Promise<DriveListing> {
      return {
        files: files.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType ?? "text/markdown",
          modifiedTime: f.modifiedTime ?? "2026-09-01T10:00:00.000Z",
          path: f.path ?? [],
        })),
        truncated: extra.truncated ?? false,
        skipped: extra.skipped ?? [],
      };
    },
    async readFile(file: DriveFile): Promise<string> {
      reads.push(file.id);
      const found = files.find((f) => f.id === file.id);
      if (!found) throw new Error(`no stub body for ${file.id}`);
      return found.body;
    },
  };
}

const FOLDER = "folder-1";

describe(
  "drive import",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("creates a draft from a document", async () => {
      const drive = stubDrive([
        {
          id: "doc-1",
          name: "On Slow Software.md",
          body: "# On Slow Software\n\nA first paragraph.\n\n## A heading\n\n- one\n- two",
        },
      ]);

      const report = await importFromDrive(db(), drive, FOLDER);
      assert.equal(report.counts.created, 1);

      const post = await getPostById(db(), report.items[0].postId!);
      assert.equal(post?.title, "On Slow Software");
      assert.equal(post?.slug, "on-slow-software");
      assert.equal(post?.excerpt, "A first paragraph.");
      assert.ok(post?.content_html?.includes("<h2>A heading</h2>"));
      assert.ok(post?.content_html?.includes("<li><p>one</p></li>"));
    });

    it("files everything as a draft, never as published", async () => {
      const drive = stubDrive([
        { id: "d1", name: "One.md", body: "# One\n\nText." },
        { id: "d2", name: "Two.md", body: "# Two\n\nText." },
      ]);
      await importFromDrive(db(), drive, FOLDER);

      // Nothing an import produces may reach a reader on its own.
      assert.equal((await getFeed(db(), 1)).totalPosts, 0);
      assert.equal(await getPublishedPost(db(), "one"), null);
    });

    it("does not duplicate on a second run", async () => {
      const drive = stubDrive([{ id: "doc-1", name: "Same.md", body: "# Same\n\nText." }]);

      const first = await importFromDrive(db(), drive, FOLDER);
      const second = await importFromDrive(db(), drive, FOLDER);

      assert.equal(first.counts.created, 1);
      assert.equal(second.counts.created, 0);
      assert.equal(second.counts.unchanged, 1);
      assert.equal(second.items[0].postId, first.items[0].postId);

      const all = await db().select().from(posts);
      assert.equal(all.length, 1);
    });

    it("does not re-download a document it has already seen", async () => {
      const drive = stubDrive([{ id: "doc-1", name: "Same.md", body: "# Same\n\nText." }]);
      await importFromDrive(db(), drive, FOLDER);
      drive.reads.length = 0;

      await importFromDrive(db(), drive, FOLDER);
      assert.deepEqual(drive.reads, [], "unchanged files should not be fetched again");
    });

    it("replaces a draft when the Drive copy is newer", async () => {
      const before = stubDrive([
        { id: "doc-1", name: "Draft.md", body: "# Draft\n\nOriginal text." },
      ]);
      const created = await importFromDrive(db(), before, FOLDER);
      const id = created.items[0].postId!;

      const after = stubDrive([
        {
          id: "doc-1",
          name: "Draft.md",
          body: "# Draft\n\nRewritten text.",
          modifiedTime: "2026-09-02T10:00:00.000Z",
        },
      ]);
      const report = await importFromDrive(db(), after, FOLDER);

      assert.equal(report.counts.updated, 1);
      const post = await getPostById(db(), id);
      assert.ok(post?.content_html?.includes("Rewritten text."));
    });

    it("never touches a post that has been published", async () => {
      const drive = stubDrive([
        { id: "doc-1", name: "Live.md", body: "# Live\n\nAs imported." },
      ]);
      const created = await importFromDrive(db(), drive, FOLDER);
      const id = created.items[0].postId!;
      await updatePost(db(), id, { status: "published" });

      const changed = stubDrive([
        {
          id: "doc-1",
          name: "Live.md",
          body: "# Live\n\nChanged in Drive after publishing.",
          modifiedTime: "2026-09-09T10:00:00.000Z",
        },
      ]);
      const report = await importFromDrive(db(), changed, FOLDER);

      assert.equal(report.counts["skipped-published"], 1);
      const post = await getPostById(db(), id);
      assert.ok(post?.content_html?.includes("As imported."));
      assert.ok(!post?.content_html?.includes("Changed in Drive"));
    });

    it("keeps the original slug when the Drive file is renamed", async () => {
      const first = stubDrive([
        { id: "doc-1", name: "Working Title.md", body: "# Working Title\n\nText." },
      ]);
      const created = await importFromDrive(db(), first, FOLDER);
      const id = created.items[0].postId!;

      const renamed = stubDrive([
        {
          id: "doc-1",
          name: "A Much Better Title.md",
          body: "# A Much Better Title\n\nText.",
          modifiedTime: "2026-09-03T10:00:00.000Z",
        },
      ]);
      await importFromDrive(db(), renamed, FOLDER);

      const post = await getPostById(db(), id);
      // The title follows the document; the URL must not.
      assert.equal(post?.title, "A Much Better Title");
      assert.equal(post?.slug, "working-title");
    });

    it("resolves a slug collision against an existing post", async () => {
      await db().insert(posts).values({ title: "Taken", slug: "taken" });
      const drive = stubDrive([{ id: "doc-1", name: "Taken.md", body: "# Taken\n\nText." }]);

      const report = await importFromDrive(db(), drive, FOLDER);
      const post = await getPostById(db(), report.items[0].postId!);
      assert.equal(post?.slug, "taken-2");
    });

    it("records which folder each document came from", async () => {
      const drive = stubDrive([
        { id: "a", name: "Top.md", body: "# Top\n\nText." },
        { id: "b", name: "Deep.md", body: "# Deep\n\nText.", path: ["Drafts", "2026"] },
      ]);
      const report = await importFromDrive(db(), drive, FOLDER);
      assert.equal(report.items[0].folder, "(top level)");
      assert.equal(report.items[1].folder, "Drafts / 2026");
    });

    it("carries on after one document fails, and says which", async () => {
      const drive: DriveClient = {
        async listFolder(): Promise<DriveListing> {
          return {
            files: [
              { id: "ok-1", name: "Fine.md", mimeType: "text/markdown", modifiedTime: "2026-09-01T10:00:00.000Z", path: [] },
              { id: "bad", name: "Broken.md", mimeType: "text/markdown", modifiedTime: "2026-09-01T10:00:00.000Z", path: [] },
              { id: "ok-2", name: "Also fine.md", mimeType: "text/markdown", modifiedTime: "2026-09-01T10:00:00.000Z", path: [] },
            ],
            truncated: false,
            skipped: [],
          };
        },
        async readFile(file) {
          if (file.id === "bad") throw new Error("Drive returned 500");
          return `# ${file.name}\n\nText.`;
        },
      };

      const report = await importFromDrive(db(), drive, FOLDER);
      assert.equal(report.counts.created, 2);
      assert.equal(report.counts.failed, 1);

      const failure = report.items.find((i) => i.outcome === "failed");
      assert.equal(failure?.file, "Broken.md");
      assert.match(failure!.detail!, /Drive returned 500/);
    });

    it("passes through what the listing could not take", async () => {
      const drive = stubDrive(
        [{ id: "a", name: "Fine.md", body: "# Fine\n\nText." }],
        { truncated: true, skipped: [{ name: "photo.jpg", reason: "an image, not a document" }] },
      );
      const report = await importFromDrive(db(), drive, FOLDER);
      assert.equal(report.truncated, true);
      assert.deepEqual(report.skipped, [
        { name: "photo.jpg", reason: "an image, not a document" },
      ]);
    });

    it("imports a document with no title of its own under its file name", async () => {
      const drive = stubDrive([
        { id: "doc-1", name: "untitled-thoughts.md", body: "Just a body, no heading." },
      ]);
      const report = await importFromDrive(db(), drive, FOLDER);
      const post = await getPostById(db(), report.items[0].postId!);
      assert.equal(post?.title, "untitled-thoughts");
    });

    it("stores provenance so the link back to Drive survives", async () => {
      const drive = stubDrive([{ id: "doc-xyz", name: "A.md", body: "# A\n\nText." }]);
      const report = await importFromDrive(db(), drive, FOLDER);

      const [row] = await db()
        .select({ driveFileId: posts.driveFileId, driveModifiedAt: posts.driveModifiedAt })
        .from(posts)
        .where(eq(posts.id, report.items[0].postId!));
      assert.equal(row.driveFileId, "doc-xyz");
      assert.ok(row.driveModifiedAt !== null);
    });
  },
);
