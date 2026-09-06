import type { MetadataRoute } from "next";
import { getDb } from "@/db/client";
import { listPublishedPageSlugs } from "@/lib/pages";
import {
  getLatestPublishedAt,
  listIndexableForSitemap,
  listPublishedSeriesSlugs,
  listPublishedTagSlugs,
} from "@/lib/public-posts";
import { absoluteUrl } from "@/lib/site";

/**
 * Refreshed on the same cadence as the list pages, so a scheduled post enters
 * the sitemap within a few minutes of going live rather than at the next
 * deploy.
 */
export const revalidate = 300;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let entries: MetadataRoute.Sitemap = [];

  try {
    const db = getDb();
    const [posts, tagSlugs, seriesSlugs, pageSlugs, latest] = await Promise.all([
      listIndexableForSitemap(db),
      listPublishedTagSlugs(db),
      listPublishedSeriesSlugs(db),
      listPublishedPageSlugs(db),
      getLatestPublishedAt(db),
    ]);

    entries = [
      {
        url: absoluteUrl("/"),
        lastModified: latest ?? new Date(),
        changeFrequency: "daily",
        priority: 1,
      },
      {
        url: absoluteUrl("/articles"),
        lastModified: latest ?? new Date(),
        changeFrequency: "daily",
        priority: 0.8,
      },
      {
        url: absoluteUrl("/aluna"),
        changeFrequency: "yearly" as const,
        priority: 0.5,
      },
      ...posts.map((post) => ({
        url: absoluteUrl(`/${post.slug}`),
        lastModified: new Date(post.published_at ?? post.created_at),
        changeFrequency: "monthly" as const,
        priority: 0.7,
      })),
      ...pageSlugs.map((slug) => ({
        url: absoluteUrl(`/${slug}`),
        changeFrequency: "yearly" as const,
        priority: 0.5,
      })),
      ...seriesSlugs.map((slug) => ({
        url: absoluteUrl(`/series/${slug}`),
        changeFrequency: "monthly" as const,
        priority: 0.5,
      })),
      ...tagSlugs.map((slug) => ({
        url: absoluteUrl(`/tag/${slug}`),
        changeFrequency: "weekly" as const,
        priority: 0.4,
      })),
    ];
  } catch (error) {
    // A sitemap listing only the homepage is recoverable; a 500 here teaches
    // crawlers the file is broken.
    console.warn("Could not build the sitemap from the database:", error);
    entries = [{ url: absoluteUrl("/"), lastModified: new Date(), priority: 1 }];
  }

  return entries;
}
