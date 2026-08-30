/**
 * Site-wide identity. Overridable by env so the name can change without a
 * code edit, with defaults that work out of the box.
 */
export const siteConfig = {
  /** One word, lowercase — it is a wordmark, not a title. */
  name: process.env.NEXT_PUBLIC_SITE_NAME ?? "topsailcashew",
  description:
    process.env.NEXT_PUBLIC_SITE_DESCRIPTION ?? "Essays, notes, and long-form writing.",
  language: "en",
  /** Shown beside the wordmark in the nav, and as the post byline. */
  author: process.env.NEXT_PUBLIC_SITE_AUTHOR ?? "Nathaniel Senje",
  authorRole: process.env.NEXT_PUBLIC_SITE_AUTHOR_ROLE ?? "Personal blog",
} as const;

/**
 * Absolute origin, e.g. https://blog.example.com.
 *
 * Read per call rather than captured at import so the value is whatever the
 * running process has — which keeps it testable and avoids a stale copy when
 * the module is bundled into more than one entry point.
 */
export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
}

/**
 * Builds an absolute URL against the configured origin. With
 * NEXT_PUBLIC_SITE_URL unset this yields a site-relative path, which is fine
 * for on-page links but wrong in a feed — see the warning in the RSS route.
 */
export function absoluteUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${siteUrl()}${suffix}`;
}

/** Long form, e.g. "30 August 2026". */
export function formatDate(value: string | Date, locale = "en-GB"): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
