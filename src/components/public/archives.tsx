import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { JsonLd } from "@/components/public/JsonLd";
import { Pagination } from "@/components/public/Pagination";
import { PostGrid } from "@/components/public/PostGrid";
import { ArchiveFilters } from "@/components/public/ArchiveFilters";
import { getFeed, getSeriesPosts, getTagName } from "@/lib/public-posts";
import { getSeriesBySlug } from "@/lib/series";
import { postListJsonLd } from "@/lib/structured-data";

/**
 * The three paginated archives, as server components.
 *
 * Each is rendered by two routes — `/articles` and `/articles/page/2`, and the
 * same again for tags and series. Keeping the body here rather than in the
 * route files is what stops those pairs drifting: before this, `/articles`
 * rendered a `<Pagination>` whose "Older →" pointed at `/page/2`, a different
 * archive entirely, because the base page and the paged route were never
 * written to agree.
 *
 * Every one of them passes `basePath`, which `Pagination` has accepted since it
 * was written and which no caller had ever supplied.
 */

/** Shared shell: head, optional filters, grid, pager. */
function Archive({
  basePath,
  head,
  jsonLd,
  feed,
  filters,
}: {
  basePath: string;
  head: React.ReactNode;
  jsonLd?: string;
  feed: Awaited<ReturnType<typeof getFeed>>;
  filters?: React.ReactNode;
}) {
  return (
    <div className="shell-wrap" id="content">
      {jsonLd && <JsonLd json={jsonLd} />}
      <div className="page-head">{head}</div>
      {filters}
      <PostGrid posts={feed.posts} />
      <Pagination page={feed.page} totalPages={feed.totalPages} basePath={basePath} />
    </div>
  );
}

export async function ArticlesArchive({ page }: { page: number }) {
  const feed = await getFeed(getDb(), page);
  if (feed.posts.length === 0) notFound();

  return (
    <Archive
      basePath="/articles"
      feed={feed}
      /* The archive as an ItemList, so a crawler reads it as a list of
         articles rather than as a page that happens to contain links. */
      jsonLd={postListJsonLd(feed.posts, {
        name: "Articles",
        path: "/articles",
        description: "Everything published, newest first.",
      })}
      filters={<ArchiveFilters />}
      head={
        <>
          <p className="label">Archive</p>
          <h1>Articles</h1>
          <p>
            {feed.totalPosts} {feed.totalPosts === 1 ? "article" : "articles"},
            newest first
            {feed.totalPages > 1 && ` · page ${feed.page} of ${feed.totalPages}`}
          </p>
        </>
      }
    />
  );
}

export async function TagArchive({ tag, page }: { tag: string; page: number }) {
  /*
    A tag with no published posts 404s rather than rendering an empty page: it
    is indistinguishable from a tag that never existed, and an empty page is
    something search engines would index for no reason.
  */
  const name = await getTagName(getDb(), tag);
  if (!name) notFound();

  const feed = await getFeed(getDb(), page, { tag });
  if (feed.posts.length === 0) notFound();

  return (
    <Archive
      basePath={`/tag/${tag}`}
      feed={feed}
      jsonLd={postListJsonLd(feed.posts, {
        name: `Tagged ${name}`,
        path: `/tag/${tag}`,
        description: `Everything tagged ${name}.`,
      })}
      filters={<ArchiveFilters currentTag={tag} />}
      head={
        <>
          <p className="label">Tagged</p>
          <h1>{name}</h1>
          <p>
            {feed.totalPosts} {feed.totalPosts === 1 ? "post" : "posts"}
            {feed.totalPages > 1 && ` · page ${feed.page} of ${feed.totalPages}`}
          </p>
        </>
      }
    />
  );
}

export async function SeriesArchive({ slug, page }: { slug: string; page: number }) {
  const db = getDb();

  const found = await getSeriesBySlug(db, slug);
  if (!found) notFound();

  // A series with nothing published yet is not something to show a reader.
  const feed = await getSeriesPosts(db, slug, page);
  if (feed.posts.length === 0) notFound();

  return (
    <Archive
      basePath={`/series/${slug}`}
      feed={feed}
      jsonLd={postListJsonLd(feed.posts, {
        name: found.title,
        path: `/series/${slug}`,
        description: found.description ?? `The ${found.title} series.`,
      })}
      filters={<ArchiveFilters currentSeries={slug} />}
      head={
        <>
          <p className="label">Series</p>
          <h1>{found.title}</h1>
          {found.description && <p>{found.description}</p>}
          <p>
            {feed.totalPosts} {feed.totalPosts === 1 ? "part" : "parts"}, in
            reading order
            {feed.totalPages > 1 && ` · page ${feed.page} of ${feed.totalPages}`}
          </p>
        </>
      }
    />
  );
}
