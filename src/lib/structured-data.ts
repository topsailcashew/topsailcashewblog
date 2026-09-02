import type { SerializedPost } from "./posts";
import { readingMinutes } from "./public-posts";
import { absoluteUrl, siteConfig, siteUrl } from "./site";

/**
 * schema.org JSON-LD.
 *
 * Search engines and social readers use this to show a headline, date and
 * author rather than guessing from the markup. It is derived entirely from
 * fields already on the page — nothing here is a second source of truth.
 */

function author() {
  return { "@type": "Person", name: siteConfig.author, url: siteUrl() || undefined };
}

export function articleJsonLd(post: SerializedPost): string {
  const published = post.published_at ?? post.created_at;
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.meta_title ?? post.title,
    description: post.meta_description ?? post.excerpt ?? siteConfig.description,
    url: absoluteUrl(`/${post.slug}`),
    // Matches the canonical in the head — a republication points both at the
    // original, so a crawler is never told two different things.
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": post.canonical_url ?? absoluteUrl(`/${post.slug}`),
    },
    datePublished: published,
    dateModified: post.updated_at,
    inLanguage: siteConfig.language,
    keywords: post.tags.map((tag) => tag.name),
    wordCount: wordCount(post.content_html),
    timeRequired: `PT${readingMinutes(post.content_html)}M`,
    image: [
      toAbsolute(post.og_image_url ?? post.cover_image_url ?? `/og/${post.slug}.png`),
    ],
    author: author(),
    publisher: { "@type": "Person", name: siteConfig.author },
  });
}

export function websiteJsonLd(): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: siteConfig.name,
    description: siteConfig.description,
    url: siteUrl() || undefined,
    inLanguage: siteConfig.language,
    author: author(),
  });
}

export function pageJsonLd(page: { title: string; slug: string; updated_at: string }): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: page.title,
    url: absoluteUrl(`/${page.slug}`),
    dateModified: page.updated_at,
    inLanguage: siteConfig.language,
    isPartOf: { "@type": "Blog", name: siteConfig.name, url: siteUrl() || undefined },
  });
}

/** Relative media paths need an origin before a crawler can fetch them. */
function toAbsolute(url: string): string {
  return /^https?:\/\//.test(url) ? url : absoluteUrl(url);
}

function wordCount(html: string | null): number {
  if (!html) return 0;
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.split(" ").length : 0;
}
