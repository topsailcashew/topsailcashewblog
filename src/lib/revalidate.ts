import { revalidatePath } from "next/cache";
import type { BlogDatabase } from "@/db/client";
import { POSTS_PER_PAGE, countPublished } from "./public-posts";

/**
 * Drops the cached public pages after a write.
 *
 * Every path is invalidated by its concrete URL. The route-pattern form —
 * `revalidatePath("/[slug]", "page")` — silently does nothing against the KV
 * tag cache: pages are stored under their real pathname, so the pattern
 * matches no entry and an unpublished post keeps serving a 200.
 */
export async function revalidatePublicPages(
  db: BlogDatabase,
  affected: { slugs?: string[]; tagSlugs?: string[] } = {},
): Promise<void> {
  try {
    const paths = new Set<string>(["/", "/rss.xml"]);

    // Both the old and new slug, so a rename leaves nothing behind at the
    // previous URL.
    for (const slug of affected.slugs ?? []) {
      if (slug) paths.add(`/${slug}`);
    }
    // Both the tags gained and the tags lost.
    for (const tagSlug of affected.tagSlugs ?? []) {
      if (tagSlug) paths.add(`/tag/${tagSlug}`);
    }

    // A new post shifts every later post down a page, so the whole run has to
    // go. One extra page covers the post that just pushed the count over.
    const totalPages = Math.ceil((await countPublished(db)) / POSTS_PER_PAGE) + 1;
    for (let page = 2; page <= totalPages; page += 1) {
      paths.add(`/page/${page}`);
    }

    for (const path of paths) revalidatePath(path);
  } catch (error) {
    // Best effort by design. The write has already committed, so failing the
    // request here would report a save that actually happened as an error.
    // The hourly `revalidate` window is the backstop for a missed drop.
    console.warn("Could not invalidate the public cache:", error);
  }
}

/**
 * Whether a write could have changed what a reader sees.
 *
 * The editor autosaves every ten seconds, so a draft being written must *not*
 * churn the public cache. A change matters when the post ends up published, or
 * when it was published before this request.
 */
export function affectsPublicOutput(
  resultingStatus: string,
  previousStatus?: string,
): boolean {
  return resultingStatus === "published" || previousStatus === "published";
}
