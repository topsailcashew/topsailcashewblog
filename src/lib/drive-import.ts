import { count, eq, isNotNull } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { posts } from "@/db/schema";
import type { DriveClient, DriveFile } from "./google-drive";
import { markdownToTiptap } from "./markdown-to-tiptap";
import { slugify, withUniqueSlug } from "./slug";
import { renderTiptapHtml } from "./tiptap-html";

/**
 * Pulls documents out of a Drive folder and files them as drafts.
 *
 * Everything arrives as a **draft**, always. An import is a transfer of raw
 * material, not a publishing decision — nothing reaches the public site until
 * the writer opens it in the editor and publishes it deliberately.
 *
 * The rules for a document that has been imported before are chosen so that a
 * second run can never destroy work:
 *
 *   - **Published post: never touched.** Once a piece is live, Drive is no
 *     longer the source of truth for it.
 *   - **Draft, unchanged in Drive: skipped.** Compared on Drive's own
 *     `modifiedTime`, so editing in the admin does not make the importer think
 *     there is something to re-fetch.
 *   - **Draft, changed in Drive: content replaced.** This is the case that can
 *     lose an edit made in the admin, which is why it is reported explicitly
 *     rather than folded into a total.
 *
 * The slug is generated once, on first import, and never revised — a slug that
 * moved because a Drive file was renamed would break the post's URL.
 */

export type ImportOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped-published"
  | "failed";

export type ImportedItem = {
  file: string;
  folder: string;
  outcome: ImportOutcome;
  postId?: string;
  title?: string;
  detail?: string;
};

export type ImportReport = {
  items: ImportedItem[];
  skipped: { name: string; reason: string }[];
  truncated: boolean;
  counts: Record<ImportOutcome, number>;
};

export async function importFromDrive(
  db: BlogDatabase,
  client: DriveClient,
  folderId: string,
): Promise<ImportReport> {
  const listing = await client.listFolder(folderId);
  const items: ImportedItem[] = [];

  for (const file of listing.files) {
    items.push(await importOne(db, client, file));
  }

  const counts: Record<ImportOutcome, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    "skipped-published": 0,
    failed: 0,
  };
  for (const item of items) counts[item.outcome] += 1;

  return { items, skipped: listing.skipped, truncated: listing.truncated, counts };
}

async function importOne(
  db: BlogDatabase,
  client: DriveClient,
  file: DriveFile,
): Promise<ImportedItem> {
  const folder = file.path.length > 0 ? file.path.join(" / ") : "(top level)";
  const base: ImportedItem = { file: file.name, folder, outcome: "failed" };

  try {
    const [existing] = await db
      .select({
        id: posts.id,
        status: posts.status,
        driveModifiedAt: posts.driveModifiedAt,
        title: posts.title,
      })
      .from(posts)
      .where(eq(posts.driveFileId, file.id))
      .limit(1);

    if (existing?.status === "published") {
      return {
        ...base,
        outcome: "skipped-published",
        postId: existing.id,
        title: existing.title,
        detail: "already published — Drive no longer overwrites it",
      };
    }

    const driveModified = new Date(file.modifiedTime);
    if (
      existing &&
      existing.driveModifiedAt !== null &&
      new Date(existing.driveModifiedAt).getTime() >= driveModified.getTime()
    ) {
      return {
        ...base,
        outcome: "unchanged",
        postId: existing.id,
        title: existing.title,
      };
    }

    const source = await client.readFile(file);
    const parsed = markdownToTiptap(source, stripExtension(file.name));
    const title = parsed.title?.trim() || stripExtension(file.name) || "Untitled";
    const html = renderTiptapHtml(parsed.doc);

    if (existing) {
      await db
        .update(posts)
        .set({
          title,
          contentJson: parsed.doc,
          contentHtml: html,
          excerpt: parsed.excerpt,
          driveModifiedAt: driveModified,
        })
        .where(eq(posts.id, existing.id));

      return { ...base, outcome: "updated", postId: existing.id, title };
    }

    /*
      Not `createPost`: the Drive id has to be written in the same insert that
      creates the row. Setting it afterwards leaves a window in which a second,
      concurrent import sees no existing post and creates a duplicate — and the
      unique index would then reject the update rather than the insert, which
      is the harder failure to recover from.
    */
    const created = await withUniqueSlug(db, slugify(title), async (slug) => {
      const [row] = await db
        .insert(posts)
        .values({
          title,
          slug,
          status: "draft",
          contentJson: parsed.doc,
          contentHtml: html,
          excerpt: parsed.excerpt,
          driveFileId: file.id,
          driveModifiedAt: driveModified,
        })
        .returning({ id: posts.id });
      return row;
    });

    return { ...base, outcome: "created", postId: created.id, title };
  } catch (cause) {
    return {
      ...base,
      outcome: "failed",
      detail: cause instanceof Error ? cause.message : "unknown error",
    };
  }
}

function stripExtension(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, "").trim();
}

/** How many posts on the site came from Drive. Shown on the import screen. */
export async function countImportedPosts(db: BlogDatabase): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(posts)
    .where(isNotNull(posts.driveFileId));
  return row?.value ?? 0;
}
