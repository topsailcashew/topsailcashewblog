/**
 * Removes file extensions left in post titles by early imports.
 *
 * The importer strips them now (see `stripFileExtension` in
 * src/lib/import-documents.ts). This is for the posts that arrived before it
 * did, where ".docx" is sitting in a published headline, in the browser tab,
 * in the RSS feed and in the JSON-LD.
 *
 * Runs through `updatePost` rather than issuing an UPDATE, which is the whole
 * point: renaming the slug there also records the 301 from the old URL and
 * repoints every internal link that pointed at it. A direct UPDATE would
 * silently break both.
 *
 * Dry by default. Pass --apply to write.
 *
 *   npx tsx scripts/strip-title-extensions.ts            # show what would change
 *   npx tsx scripts/strip-title-extensions.ts --apply    # do it
 */
import { isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { posts } from "@/db/schema";
import { stripFileExtension } from "@/lib/import-documents";
import { updatePost } from "@/lib/posts";
import { slugify } from "@/lib/slug";
import { loadEnv } from "./load-env";

loadEnv();

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = getDb();

  const rows = await db
    .select({ id: posts.id, title: posts.title, slug: posts.slug, status: posts.status })
    .from(posts)
    .where(isNull(posts.deletedAt));

  const affected = rows
    .map((row) => ({ ...row, cleanTitle: stripFileExtension(row.title) }))
    .filter((row) => row.cleanTitle !== row.title && row.cleanTitle !== "");

  if (affected.length === 0) {
    console.log("No titles carry a file extension. Nothing to do.");
    return;
  }

  console.log(`${affected.length} post${affected.length === 1 ? "" : "s"} to clean:\n`);
  for (const row of affected) {
    const cleanSlug = slugify(row.cleanTitle);
    console.log(`  ${row.title}`);
    console.log(`    title -> ${row.cleanTitle}`);
    console.log(
      row.slug === cleanSlug
        ? `    slug  -> /${row.slug} (unchanged)`
        : `    slug  -> /${cleanSlug}   (/${row.slug} will 301 here)`,
    );
    console.log(`    status: ${row.status}\n`);
  }

  if (!apply) {
    console.log("Dry run. Re-run with --apply to write these changes.");
    return;
  }

  for (const row of affected) {
    const cleanSlug = slugify(row.cleanTitle);
    await updatePost(db, row.id, {
      title: row.cleanTitle,
      // Passed only when it actually differs: `updatePost` treats any slug it
      // is given as a rename, and a no-op rename would still write a redirect.
      ...(cleanSlug !== row.slug ? { slug: cleanSlug } : {}),
    });
    console.log(`  updated ${row.cleanTitle}`);
  }

  console.log(
    `\nDone. Redirects recorded for any changed slug, and internal links repointed.`,
  );
  console.log("The public cache is dropped on the next write, or within the hour.");
}

main().catch((error) => {
  console.error("Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
