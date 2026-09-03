import Link from "next/link";
import { getDb } from "@/db/client";
import { listProminentTags, listPublishedSeries } from "@/lib/public-posts";

/**
 * Tag and series filters, as links.
 *
 * The homepage has had a Categories row for a while, but it filters the eleven
 * cards already in the DOM with `useState` — so a filtered view cannot be
 * linked, shared, or arrived at from anywhere else, and it does not exist on
 * any other page. This is the durable version: every filter is a URL that
 * already had a page behind it.
 *
 * A server component, so the vocabulary is not shipped to the browser and the
 * bar is in the HTML for a crawler to follow — which is how tag and series
 * pages get discovered at all. Until now `/series/x` was reachable only from
 * the "Part N of M" line on a post, and `/series` did not exist.
 */

/** Enough to be a vocabulary, not so many that the bar becomes the page. */
const MAX_TAGS = 12;

export async function ArchiveFilters({
  currentTag,
  currentSeries,
}: {
  currentTag?: string;
  currentSeries?: string;
}) {
  const db = getDb();

  // Both are best-effort: a filter bar is navigation, and losing it should
  // never take the archive down with it.
  const [tags, series] = await Promise.all([
    listProminentTags(db, MAX_TAGS).catch(() => []),
    listPublishedSeries(db).catch(() => []),
  ]);
  if (tags.length === 0 && series.length === 0) return null;

  const filtered = Boolean(currentTag || currentSeries);

  return (
    <nav className="archive-filters" aria-label="Filter the archive">
      {tags.length > 0 && (
        <div className="archive-filter-group">
          <span className="label">Tags</span>
          <div className="archive-filter-list">
            <Link
              href="/articles"
              className={filtered ? "tag-pill" : "tag-pill is-active"}
              aria-current={filtered ? undefined : "page"}
            >
              All
            </Link>
            {tags.map((tag) => (
              <Link
                key={tag.slug}
                href={`/tag/${tag.slug}`}
                className={tag.slug === currentTag ? "tag-pill is-active" : "tag-pill"}
                aria-current={tag.slug === currentTag ? "page" : undefined}
              >
                {tag.name}
                <span className="pill-count">{tag.count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {series.length > 0 && (
        <div className="archive-filter-group">
          <span className="label">
            <Link href="/series">Series</Link>
          </span>
          <div className="archive-filter-list">
            {series.map((entry) => (
              <Link
                key={entry.slug}
                href={`/series/${entry.slug}`}
                className={
                  entry.slug === currentSeries ? "tag-pill is-active" : "tag-pill"
                }
                aria-current={entry.slug === currentSeries ? "page" : undefined}
              >
                {entry.title}
                <span className="pill-count">{entry.count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
