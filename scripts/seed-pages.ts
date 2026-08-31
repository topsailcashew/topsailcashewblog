/**
 * Creates the pages the nav links to, if they do not exist yet.
 *
 * The nav links to /about, /newsletter and /contact unconditionally, so
 * without this a fresh install has three links that 404. The copy below is
 * deliberately plain placeholder text — it is a starting point to edit at
 * /admin/pages, not something to leave as it is.
 *
 * Safe to re-run: a page that already exists is left completely alone, so this
 * never overwrites edited copy.
 */
import { eq } from "drizzle-orm";
import { pages } from "../src/db/schema";
import { createNodeDb } from "../src/db/node";
import { requireDatabaseUrl } from "./load-env";

type Seed = { slug: string; title: string; paragraphs: string[] };

const SEEDS: Seed[] = [
  {
    slug: "about",
    title: "About",
    paragraphs: [
      "This is where the writing lives. Essays, notes, and whatever else is worth the time to set down properly.",
      "Replace this text from the admin — it is an ordinary page, edited in the same editor as a post.",
    ],
  },
  {
    slug: "newsletter",
    title: "Newsletter",
    paragraphs: [
      "There is no mailing list yet. In the meantime the RSS feed carries every post in full, and works in any reader.",
      "Subscribe at /rss.xml.",
    ],
  },
  {
    slug: "contact",
    title: "Contact",
    paragraphs: [
      "The quickest way to reach me is email. Add your address here — a plain address rather than a form, so replies land in a real inbox and nothing needs a spam filter of its own.",
      "Comments are open on every post, too.",
    ],
  },
];

/** Tiptap's document shape, so the editor opens these as normal prose. */
function toDoc(paragraphs: string[]) {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

function toHtml(paragraphs: string[]): string {
  return paragraphs
    .map((text) => `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
    .join("");
}

async function main() {
  const url = requireDatabaseUrl();
  const { db, pool } = createNodeDb(url);

  try {
    for (const seed of SEEDS) {
      const [existing] = await db
        .select({ id: pages.id })
        .from(pages)
        .where(eq(pages.slug, seed.slug))
        .limit(1);

      if (existing) {
        console.log(`  /${seed.slug} already exists — left as it is`);
        continue;
      }

      await db.insert(pages).values({
        title: seed.title,
        slug: seed.slug,
        contentJson: toDoc(seed.paragraphs),
        contentHtml: toHtml(seed.paragraphs),
        status: "published",
      });
      console.log(`  /${seed.slug} created`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Seeding pages failed:", error);
  process.exit(1);
});
