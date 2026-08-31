import { asc, eq } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { pages, type PageRow, type PostStatus } from "@/db/schema";
import { notFound } from "./http";
import { slugify, withUniqueSlug } from "./slug";
import type { CreatePageInput, UpdatePageInput } from "./validation";

/**
 * Standalone pages — About, Newsletter, Contact.
 *
 * These are ordinary editable documents, not hardcoded routes, so the copy is
 * the author's to change without a deploy. They render through `/[slug]`,
 * which resolves a post first and falls back to a page.
 */

export type SerializedPage = {
  id: string;
  title: string;
  slug: string;
  content_json: unknown;
  content_html: string | null;
  status: PostStatus;
  created_at: string;
  updated_at: string;
};

export function serializePage(row: PageRow): SerializedPage {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    content_json: row.contentJson ?? null,
    content_html: row.contentHtml,
    status: row.status,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function listPages(db: BlogDatabase): Promise<SerializedPage[]> {
  const rows = await db.select().from(pages).orderBy(asc(pages.title));
  return rows.map(serializePage);
}

export async function getPageById(
  db: BlogDatabase,
  id: string,
): Promise<SerializedPage | null> {
  const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
  return row ? serializePage(row) : null;
}

/** Public read. Never returns a draft — same contract as `getPublishedPost`. */
export async function getPublishedPage(
  db: BlogDatabase,
  slug: string,
): Promise<SerializedPage | null> {
  const [row] = await db
    .select()
    .from(pages)
    .where(eq(pages.slug, slug))
    .limit(1);
  if (!row || row.status !== "published") return null;
  return serializePage(row);
}

export async function listPublishedPageSlugs(db: BlogDatabase): Promise<string[]> {
  const rows = await db
    .select({ slug: pages.slug })
    .from(pages)
    .where(eq(pages.status, "published"));
  return rows.map((row) => row.slug);
}

export async function createPage(
  db: BlogDatabase,
  input: CreatePageInput,
): Promise<SerializedPage> {
  const base = input.slug ?? slugify(input.title);
  const row = await withUniqueSlug(db, base, async (slug) => {
    const [created] = await db
      .insert(pages)
      .values({
        title: input.title.trim(),
        slug,
        contentJson: input.content_json ?? null,
        contentHtml: input.content_html ?? null,
        status: input.status ?? "draft",
      })
      .returning();
    return created;
  });
  return serializePage(row);
}

export type UpdatePageResult = {
  page: SerializedPage;
  /** The slug it occupied before, so a rename can invalidate the old URL. */
  previousSlug: string;
};

export async function updatePage(
  db: BlogDatabase,
  id: string,
  input: UpdatePageInput,
): Promise<UpdatePageResult> {
  const [existing] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
  if (!existing) throw notFound("Page");

  const patch: Partial<typeof pages.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.content_json !== undefined) patch.contentJson = input.content_json;
  if (input.content_html !== undefined) patch.contentHtml = input.content_html;
  if (input.status !== undefined) patch.status = input.status;

  const row =
    input.slug !== undefined && input.slug !== existing.slug
      ? await withUniqueSlug(
          db,
          input.slug,
          (slug) => applyPatch(db, id, { ...patch, slug }),
          { excludeId: id },
        )
      : Object.keys(patch).length > 0
        ? await applyPatch(db, id, patch)
        : existing;

  return { page: serializePage(row), previousSlug: existing.slug };
}

export async function deletePage(db: BlogDatabase, id: string): Promise<void> {
  const deleted = await db
    .delete(pages)
    .where(eq(pages.id, id))
    .returning({ id: pages.id });
  if (deleted.length === 0) throw notFound("Page");
}

async function applyPatch(
  db: BlogDatabase,
  id: string,
  patch: Partial<typeof pages.$inferInsert>,
): Promise<PageRow> {
  const [updated] = await db
    .update(pages)
    .set(patch)
    .where(eq(pages.id, id))
    .returning();
  if (!updated) throw notFound("Page");
  return updated;
}
