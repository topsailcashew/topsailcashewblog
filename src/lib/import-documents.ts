import { count, eq, isNotNull } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { posts } from "@/db/schema";
import { markdownToTiptap } from "./markdown-to-tiptap";
import { slugify, withUniqueSlug } from "./slug";
import { renderTiptapHtml } from "./tiptap-html";

/**
 * Turns a dropped document into a draft.
 *
 * Everything arrives as a **draft**, always. An import is a transfer of raw
 * material, not a publishing decision — nothing reaches the public site until
 * it is opened in the editor and published deliberately.
 *
 * Documents are identified by their path within the folder that was dropped,
 * so dropping the same folder again updates the drafts it made last time
 * rather than producing a second copy of everything. Two rules keep that from
 * destroying work:
 *
 *   - **A published post is never touched.** Once a piece is live, the file on
 *     disk stops being the source of truth for it.
 *   - **The slug is generated once** and never revised. A slug that moved
 *     because a file was renamed would break the post's URL.
 */

export type ImportOutcome = "created" | "updated" | "skipped-published" | "failed";

export type ImportedDocument = {
  /** Path within the drop, e.g. "essays/2026/slow-software.md". */
  path: string;
  content: string;
};

export type ImportedItem = {
  path: string;
  outcome: ImportOutcome;
  postId?: string;
  title?: string;
  detail?: string;
};

export async function importDocument(
  db: BlogDatabase,
  document: ImportedDocument,
): Promise<ImportedItem> {
  const base: ImportedItem = { path: document.path, outcome: "failed" };

  try {
    const [existing] = await db
      .select({ id: posts.id, status: posts.status, title: posts.title })
      .from(posts)
      .where(eq(posts.importKey, document.path))
      .limit(1);

    if (existing?.status === "published") {
      return {
        ...base,
        outcome: "skipped-published",
        postId: existing.id,
        title: existing.title,
        detail: "already published — dropping the file again will not overwrite it",
      };
    }

    const parsed = markdownToTiptap(document.content, fileTitle(document.path));
    const title = parsed.title?.trim() || fileTitle(document.path) || "Untitled";
    const html = renderTiptapHtml(parsed.doc);

    if (existing) {
      await db
        .update(posts)
        .set({
          title,
          contentJson: parsed.doc,
          contentHtml: html,
          excerpt: parsed.excerpt,
          importedAt: new Date(),
        })
        .where(eq(posts.id, existing.id));
      return { ...base, outcome: "updated", postId: existing.id, title };
    }

    /*
      The import key is written in the same INSERT that creates the row.
      Setting it afterwards leaves a window in which a second, concurrent
      import sees no existing post and creates a duplicate — and the unique
      index would then reject the update rather than the insert, which is the
      harder failure to recover from.
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
          importKey: document.path,
          importedAt: new Date(),
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

/**
 * The file's own name, without directories or extension.
 *
 * Every extension the importer accepts has to be listed here, not just the
 * text ones. A .docx with no Title style and no leading heading falls back to
 * its filename, and a missing entry here puts the extension in the title of a
 * published post — where it is visible to readers and outlives the import.
 */
const TITLE_EXTENSIONS = /\.(docx|md|markdown|txt)$/i;

function fileTitle(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(TITLE_EXTENSIONS, "").trim();
}

/** How many posts came from an import. Shown on the import screen. */
export async function countImportedPosts(db: BlogDatabase): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(posts)
    .where(isNotNull(posts.importKey));
  return row?.value ?? 0;
}
