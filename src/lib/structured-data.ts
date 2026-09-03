import type { SerializedPost } from "./posts";
import { readingMinutes } from "./public-posts";
import { absoluteUrl, siteConfig, siteUrl } from "./site";

/**
 * schema.org JSON-LD.
 *
 * Two audiences now. Search engines have always used this to show a headline,
 * date and author rather than guessing from the markup. The newer one is
 * retrieval systems building answers: an AI overview citing a page needs to
 * know who wrote it, when, what it is about and where the canonical copy
 * lives, and it will take that from structured data long before it will infer
 * it from a `<div>`.
 *
 * Everything here is derived from fields already on the page. Nothing in this
 * file is a second source of truth — if a value disagrees with the rendered
 * page, the bug is here.
 *
 * ## On placement
 *
 * These blocks are rendered by the page component, which puts them in the
 * body. schema.org, Google and Bing all accept JSON-LD anywhere in the
 * document; Next's Metadata API has no slot for a script, so the head is not
 * available without hand-writing one. Body is the supported placement, not a
 * compromise on validity.
 */

const PERSON_ID = "#author";
const SITE_ID = "#site";

function author() {
  return {
    "@type": "Person",
    "@id": absoluteUrl(`/${PERSON_ID}`),
    name: siteConfig.author,
    url: siteUrl() || undefined,
    email: siteConfig.contactEmail,
  };
}

function site() {
  return {
    "@type": "Blog",
    "@id": absoluteUrl(`/${SITE_ID}`),
    name: siteConfig.name,
    url: siteUrl() || undefined,
  };
}

export function articleJsonLd(
  post: SerializedPost,
  options: { commentCount?: number } = {},
): string {
  const published = post.published_at ?? post.created_at;
  const url = absoluteUrl(`/${post.slug}`);

  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.meta_title ?? post.title,
    // `name` alongside `headline` because they are allowed to differ: a
    // headline may be trimmed for display, and consumers pick whichever the
    // surface needs.
    name: post.title,
    description: post.meta_description ?? post.excerpt ?? siteConfig.description,
    url,
    // Matches the canonical in the head — a republication points both at the
    // original, so a crawler is never told two different things.
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": post.canonical_url ?? url,
    },
    datePublished: published,
    dateModified: post.updated_at,
    inLanguage: siteConfig.language,
    keywords: post.tags.map((tag) => tag.name),
    articleSection: post.tags[0]?.name,
    wordCount: wordCount(post.content_html),
    timeRequired: `PT${readingMinutes(post.content_html)}M`,
    image: imageObject(
      post.og_image_url ?? post.cover_image_url ?? `/og/${post.slug}.png`,
    ),
    author: author(),
    publisher: {
      "@type": "Person",
      "@id": absoluteUrl(`/${PERSON_ID}`),
      name: siteConfig.author,
    },
    isPartOf: site(),
    /*
      Marks the parts worth reading aloud, and — more usefully now — the parts
      a summariser should treat as the substance of the page rather than the
      chrome around it.
    */
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: [".article-title", ".article-lede", ".prose"],
    },
    ...(post.noindex
      ? {}
      : {
          // Only claimed for a page that is actually open to comments and
          // indexable; asserting it on a hidden post is a promise the page
          // does not keep.
          commentCount: options.commentCount ?? 0,
          discussionUrl: `${url}#comments`,
        }),
  });
}

/**
 * The site itself, plus the fact that it has a search box.
 *
 * `SearchAction` is what lets a result carry its own search field, and what
 * tells a retrieval system there is a way to look inside this site rather than
 * only at the pages it happened to crawl.
 */
export function websiteJsonLd(): string {
  const origin = siteUrl();
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    "@id": absoluteUrl(`/${SITE_ID}`),
    name: siteConfig.name,
    description: siteConfig.description,
    url: origin || undefined,
    inLanguage: siteConfig.language,
    author: author(),
    publisher: author(),
    ...(origin
      ? {
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: `${origin}/search?q={search_term_string}`,
            },
            "query-input": "required name=search_term_string",
          },
        }
      : {}),
  });
}

/**
 * The trail to a page.
 *
 * Worth its own block: it is what turns a bare URL in a result into
 * "topsailcashew › Articles › On slow software", and it gives a retrieval
 * system the page's place in the site rather than leaving it to guess from
 * the path.
 */
export function breadcrumbJsonLd(trail: { name: string; path: string }[]): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((step, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: step.name,
      item: absoluteUrl(step.path),
    })),
  });
}

/** An index of posts — the archive, a tag, a series. */
export function postListJsonLd(
  entries: { title: string; slug: string; publishedAt?: string | Date | null }[],
  options: { name: string; path: string; description?: string },
): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: options.name,
    description: options.description ?? siteConfig.description,
    url: absoluteUrl(options.path),
    inLanguage: siteConfig.language,
    isPartOf: site(),
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: entries.length,
      itemListElement: entries.map((entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: absoluteUrl(`/${entry.slug}`),
        name: entry.title,
      })),
    },
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
    isPartOf: site(),
    author: author(),
  });
}

/**
 * An ImageObject rather than a bare URL.
 *
 * A URL says only "there is a picture"; this says how big it is, which is what
 * decides whether a result gets a thumbnail or a full-width card.
 */
function imageObject(url: string) {
  return {
    "@type": "ImageObject",
    url: toAbsolute(url),
    width: 1200,
    height: 630,
  };
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
