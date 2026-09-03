import { eq, ilike } from "drizzle-orm";
import type { BlogDatabase } from "@/db/client";
import { pages, posts } from "@/db/schema";
import { normalizePath } from "./redirects";
import { renderTiptapHtml } from "./tiptap-html";

/**
 * Rewrites links that pointed at a renamed page.
 *
 * ## Why this exists on top of redirects
 *
 * A redirect keeps the *outside* world working: an inbound link from someone
 * else's site still arrives. It does nothing for the links this blog holds
 * about itself. Rename a post that four other posts link to, and those four
 * now go through a 301 forever — one extra round trip each, link equity spent
 * on a hop, and an editor who opens one of those posts sees the old URL and
 * has no idea it is stale.
 *
 * Worse, redirects are a chain that can break in a way nothing reports. Rename
 * a → b, then rename something else *into* a, and the redirect for a is
 * dropped (correctly — a post lives there now), at which point those four
 * links quietly point at a completely different article. The only durable fix
 * is for the links themselves to be right.
 *
 * ## Where it runs
 *
 * Inline with the rename, not in the background. The rename already
 * invalidates the public cache, and a rewrite that landed after that drop
 * would leave the old links sitting in freshly-cached pages until the next
 * write — which is exactly the failure this is meant to remove. The scan is a
 * LIKE over one blog's worth of rows and costs a few milliseconds.
 */

/** How many documents one rename will rewrite. A guard, not a policy. */
const MAX_DOCUMENTS = 200;

export type LinkRewriteResult = {
  posts: number;
  pages: number;
  links: number;
};

export async function rewriteInternalLinks(
  db: BlogDatabase,
  fromPath: string,
  toPath: string,
  options: { siteUrl?: string } = {},
): Promise<LinkRewriteResult> {
  const from = normalizePath(fromPath);
  const to = normalizePath(toPath);
  const result: LinkRewriteResult = { posts: 0, pages: 0, links: 0 };
  if (from === to || from === "/") return result;

  /*
    Candidates are found with a LIKE over the rendered HTML rather than by
    searching the JSON. The HTML is a flat string that Postgres can scan
    without a jsonb path expression, and it is derived from the same document —
    so anything with a link in the JSON has that link in the HTML too.
  */
  const needle = `%${escapeLike(from)}%`;

  const [postRows, pageRows] = await Promise.all([
    db
      .select({ id: posts.id, contentJson: posts.contentJson })
      .from(posts)
      .where(ilike(posts.contentHtml, needle))
      .limit(MAX_DOCUMENTS),
    db
      .select({ id: pages.id, contentJson: pages.contentJson })
      .from(pages)
      .where(ilike(pages.contentHtml, needle))
      .limit(MAX_DOCUMENTS),
  ]);

  const origins = options.siteUrl ? [options.siteUrl.replace(/\/+$/, "")] : [];

  for (const row of postRows) {
    const rewritten = rewriteDocument(row.contentJson, from, to, origins);
    if (rewritten.changed === 0) continue;

    await db
      .update(posts)
      .set({
        contentJson: rewritten.doc,
        // Re-derived here rather than left stale: content_html is what the
        // reading page renders and what the next scan searches, so leaving it
        // behind would make this run again and find the same rows forever.
        contentHtml: renderTiptapHtml(rewritten.doc),
      })
      .where(eq(posts.id, row.id));
    result.posts += 1;
    result.links += rewritten.changed;
  }

  for (const row of pageRows) {
    const rewritten = rewriteDocument(row.contentJson, from, to, origins);
    if (rewritten.changed === 0) continue;

    await db
      .update(pages)
      .set({ contentJson: rewritten.doc, contentHtml: renderTiptapHtml(rewritten.doc) })
      .where(eq(pages.id, row.id));
    result.pages += 1;
    result.links += rewritten.changed;
  }

  return result;
}

type Node = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
};

/**
 * Returns a new document with matching hrefs repointed.
 *
 * Structurally copied rather than mutated: the input is a jsonb value read
 * from the row, and editing it in place would make a partial rewrite — one
 * that threw halfway — indistinguishable from a complete one.
 */
export function rewriteDocument(
  doc: unknown,
  from: string,
  to: string,
  origins: string[] = [],
): { doc: unknown; changed: number } {
  if (!doc || typeof doc !== "object") return { doc, changed: 0 };

  let changed = 0;

  const rewriteHref = (href: string): string => {
    const next = repoint(href, from, to, origins);
    if (next !== href) changed += 1;
    return next;
  };

  const walk = (node: Node): Node => {
    const next: Node = { ...node };

    if (node.marks) {
      next.marks = node.marks.map((mark) => {
        if (mark.type !== "link" || typeof mark.attrs?.href !== "string") return mark;
        return { ...mark, attrs: { ...mark.attrs, href: rewriteHref(mark.attrs.href) } };
      });
    }

    // Images are addressed by URL too, and an image served from a renamed
    // route would 404 just as loudly as a link would.
    if (node.type === "image" && typeof node.attrs?.src === "string") {
      next.attrs = { ...node.attrs, src: rewriteHref(node.attrs.src) };
    }

    if (node.content) next.content = node.content.map(walk);
    return next;
  };

  const source = doc as Node;
  const rewritten: Node = {
    ...source,
    content: (source.content ?? []).map(walk),
  };
  return { doc: rewritten, changed };
}

/**
 * Repoints one href, if it addresses `from`.
 *
 * The query string and fragment are carried across — a link to
 * `/old-post#the-argument` should land on `/new-post#the-argument`, not on the
 * top of the page. Absolute URLs on this site's own origin are matched too,
 * because writers paste them from the address bar.
 */
export function repoint(
  href: string,
  from: string,
  to: string,
  origins: string[] = [],
): string {
  const matchedOrigin = origins.find((origin) => origin && href.startsWith(`${origin}/`));
  const rest = matchedOrigin ? href.slice(matchedOrigin.length) : href;

  // Only site-relative paths from here; anything else belongs to another site.
  if (!rest.startsWith("/") || rest.startsWith("//")) return href;

  const suffixAt = rest.search(/[?#]/);
  const path = suffixAt === -1 ? rest : rest.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : rest.slice(suffixAt);

  if (normalizePath(path) !== from) return href;
  return `${matchedOrigin ?? ""}${to}${suffix}`;
}

/** `%` and `_` are wildcards in LIKE; a slug can legitimately contain `_`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
