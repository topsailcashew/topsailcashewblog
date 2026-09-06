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

/**
 * A block of seeded copy.
 *
 * Paragraphs alone were enough while the seeds were two-paragraph
 * placeholders. The Aluna page is a real page of copy with sections, so the
 * seed has to be able to express a heading and a pull-quote — otherwise the
 * only way to get one is to hand-write HTML into the database, which is the
 * thing the admin editor exists to avoid.
 */
type Block = { kind: "p" | "h2" | "quote"; text: string };

type Seed = { slug: string; title: string; blocks: Block[] };

/** Shorthands, so the seeds below read as copy rather than as data. */
const p = (text: string): Block => ({ kind: "p", text });
const h2 = (text: string): Block => ({ kind: "h2", text });
const quote = (text: string): Block => ({ kind: "quote", text });

const SEEDS: Seed[] = [
  {
    slug: "about",
    title: "About",
    blocks: [
      p("This is where the writing lives. Essays, notes, and whatever else is worth the time to set down properly."),
      p("Replace this text from the admin — it is an ordinary page, edited in the same editor as a post."),
    ],
  },
  {
    slug: "contact",
    title: "Contact",
    blocks: [
      p("The quickest way to reach me is email. Add your address here — a plain address rather than a form, so replies land in a real inbox and nothing needs a spam filter of its own."),
      p("Comments are open on every post, too."),
    ],
  },
  {
    slug: "aluna",
    title: "Aluna",
    blocks: [
      p(
        "Most mood trackers ask how you feel on a scale of one to five. Aluna asks where you feel it, which feeling it actually is out of eighty-two, and what your mind has been doing — then shows you what that adds up to over weeks.",
      ),
      p(
        "Every entry is encrypted on your device before it is sent. Nobody else can read your check-ins, including whoever runs the app.",
      ),

      h2("Checking in"),
      p(
        "The quick path is the emotion wheel and a few optional context taps — under fifteen seconds once you know your way around. The full path adds a body scan, thought patterns and a guided reflection. Both write the same kind of entry, and skipping a step costs you nothing.",
      ),
      p(
        "The wheel goes seven families, then forty-one sub-categories, then eighty-two specific emotions: you start broad and narrow until it fits. You can pick as many as are true, including contradictory ones. Precision is the point — “uneasy” and “dreading” ask for different things, and working out which one it is tends to be more useful than any advice about it.",
      ),
      p(
        "The body map is twenty-nine locations on a figure you tap, each with an intensity and room for a note. Bodies often notice before minds do.",
      ),

      h2("What you get back"),
      p(
        "Saving a check-in offers a short piece of writing about what you logged — what that feeling tends to be like, and three ordinary things that can help. Pleasant feelings get noticing rather than fixing; nothing here treats a good day as a problem to manage.",
      ),
      quote(
        "That writing is fixed text, written in advance and reviewed. It is not generated, and that is a privacy decision before it is an editorial one.",
      ),
      p(
        "Sending your emotional state to a third party on every check-in is exactly what the encryption exists to prevent. An API would have made the promise on the sign-up screen a lie the moment it shipped. Fixed text also means every sentence can be read before someone in a bad state reads it, which matters where a confidently wrong line lands hard.",
      ),

      h2("What it adds up to"),
      p(
        "A mood trend, the distribution of your feelings, a twenty-week grid, and plain-language observations about what your feelings travel with. History is a month calendar coloured by the dominant feeling, and the home screen takes the colour of whatever today has been.",
      ),
      p(
        "Observations only appear once there is enough to draw on — ten entries overall, four either side of any comparison, and a real gap between them. A pattern found in four check-ins is noise, and saying it confidently would be worse than saying nothing.",
      ),

      h2("Or don’t, for a while"),
      p(
        "There is no streak to protect and no notification that can interrupt you. The calendar shows the gaps honestly rather than smoothing them over. Missing a week costs you nothing.",
      ),
      p(
        "There is also a journal — a blank page, separate from check-ins, encrypted the same way, with no prompts and no length anyone expects of you. And four guided breathing patterns, whose sound is synthesised in the browser rather than shipped as audio files.",
      ),

      h2("Nobody else can read it"),
      quote(
        "Entry content is encrypted in your browser with a key derived from your password. The key never reaches the server.",
      ),
      p(
        "A random data key does the encrypting, and is stored only as two wrapped copies: one sealed by your password, one by a twelve-word recovery phrase shown once at sign-up. Changing your password re-wraps the key, instantly, however many entries exist.",
      ),
      p(
        "Losing both the password and the phrase makes every entry permanently unreadable, by anyone. There is no reset and no backup. That is the trade, and it is the honest one: nobody can read your entries, which is the same fact as nobody can recover them.",
      ),
      p(
        "What is not encrypted, because the app cannot work otherwise: your email, display name, avatar, timestamps, preferences, and anything you deliberately post to Community. Aluna’s own privacy page says so plainly rather than implying everything is covered.",
      ),
    ],
  },
];

/** Tiptap's document shape, so the editor opens these as normal prose. */
function toDoc(blocks: Block[]) {
  return {
    type: "doc",
    content: blocks.map((block) => {
      const paragraph = { type: "paragraph", content: [{ type: "text", text: block.text }] };
      if (block.kind === "h2") {
        return { type: "heading", attrs: { level: 2 }, content: paragraph.content };
      }
      if (block.kind === "quote") return { type: "blockquote", content: [paragraph] };
      return paragraph;
    }),
  };
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function toHtml(blocks: Block[]): string {
  return blocks
    .map((block) => {
      const text = escape(block.text);
      if (block.kind === "h2") return `<h2>${text}</h2>`;
      if (block.kind === "quote") return `<blockquote><p>${text}</p></blockquote>`;
      return `<p>${text}</p>`;
    })
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
        contentJson: toDoc(seed.blocks),
        contentHtml: toHtml(seed.blocks),
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
