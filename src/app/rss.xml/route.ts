import { getDb } from "@/db/client";
import { listPublishedForFeed } from "@/lib/public-posts";
import { absoluteUrl, siteConfig, siteUrl } from "@/lib/site";

/**
 * Static, like the reading pages, and dropped by the same `revalidatePath`
 * call when a post is written. The hourly window is the safety net.
 */
export const dynamic = "force-static";
/* Five-minute window so scheduled posts surface promptly — see app/(public)/page.tsx. */
export const revalidate = 300;

/** Most recent posts only — a feed reader has no use for the whole archive. */
const FEED_LIMIT = 50;

export async function GET(): Promise<Response> {
  if (!siteUrl()) {
    // Feed readers resolve relative URLs against their own origin, so without
    // this the links and images in every item point at the wrong host.
    console.warn(
      "NEXT_PUBLIC_SITE_URL is unset — RSS links will be relative and will not resolve in a reader.",
    );
  }

  const posts = await listPublishedForFeed(getDb(), FEED_LIMIT);
  const self = absoluteUrl("/rss.xml");
  const latest = posts[0]?.published_at ?? posts[0]?.created_at;

  const items = posts
    .map((post) => {
      const url = absoluteUrl(`/${post.slug}`);
      const published = post.published_at ?? post.created_at;
      return [
        "    <item>",
        `      <title>${escapeXml(post.title)}</title>`,
        `      <link>${escapeXml(url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
        `      <pubDate>${toRfc822(published)}</pubDate>`,
        post.excerpt
          ? `      <description>${escapeXml(post.excerpt)}</description>`
          : null,
        ...post.tags.map(
          (tag) => `      <category>${escapeXml(tag.name)}</category>`,
        ),
        post.content_html
          ? `      <content:encoded>${cdata(absolutiseUrls(post.content_html))}</content:encoded>`
          : null,
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(siteConfig.name)}</title>
    <link>${escapeXml(absoluteUrl("/"))}</link>
    <description>${escapeXml(siteConfig.description)}</description>
    <language>${siteConfig.language}</language>
${latest ? `    <lastBuildDate>${toRfc822(latest)}</lastBuildDate>\n` : ""}    <atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=3600",
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * CDATA cannot contain the sequence `]]>`; splitting across two sections is
 * the standard way to carry it through intact.
 */
function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

/**
 * Uploaded images are stored as site-relative paths like `/media/…`. A feed
 * reader resolves against its own origin, so they have to be absolute here.
 */
function absolutiseUrls(html: string): string {
  return html.replace(
    /(<(?:img|a)\b[^>]*?\b(?:src|href)=")(\/(?!\/)[^"]*)"/gi,
    (_match, prefix: string, path: string) => `${prefix}${absoluteUrl(path)}"`,
  );
}

function toRfc822(value: string): string {
  return new Date(value).toUTCString();
}
