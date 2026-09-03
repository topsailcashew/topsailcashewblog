import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { PostGrid } from "@/components/public/PostGrid";
import { SubscribeSection } from "@/components/public/SubscribeSection";
import {
  getFeaturedPost,
  getFeed,
  searchPublished,
  type PostSummary,
} from "@/lib/public-posts";

/** Results depend on the query string, so there is nothing to pre-render. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Search",
  // A results page has no business in an index.
  robots: { index: false, follow: true },
};

type SearchParams = Promise<{ q?: string }>;

/** How many pieces to offer when a search comes back empty. */
const SUGGESTION_COUNT = 3;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const db = getDb();

  let results: Awaited<ReturnType<typeof searchPublished>> = [];
  let failed = false;
  if (query !== "") {
    try {
      results = await searchPublished(db, query);
    } catch {
      // websearch_to_tsquery tolerates almost anything, but a malformed query
      // should read as "no results", never as a stack trace.
      failed = true;
    }
  }

  /*
    Loaded whenever there is nothing to show — an empty search, a failed one,
    or one that matched nothing. A dead end is the moment a reader leaves, and
    the archive is small enough that "here is what else is here" is a better
    answer than an apology.
  */
  const nothingToShow = results.length === 0;
  const suggestions = nothingToShow ? await suggestedReading(db) : [];

  return (
    <div className="shell-wrap" id="content">
      <div className="page-head">
        <h1>Search</h1>
        {/* A plain GET form: no JavaScript, and the results are linkable. */}
        <form method="get" action="/search" role="search" className="search-form">
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search posts…"
            aria-label="Search posts"
            autoFocus
          />
          <button type="submit" className="btn btn--primary">Search</button>
        </form>
      </div>

      {nothingToShow ? (
        <>
          <p className="search-empty">
            {query === "" ? (
              "Search the archive, or start with one of these."
            ) : failed ? (
              <>That search could not be run. Try simpler terms — or start here.</>
            ) : (
              <>
                Nothing matches <strong>{query}</strong>, spelling allowed for.
                Here is what else is worth reading.
              </>
            )}
          </p>

          {suggestions.length > 0 && (
            <>
              <h2 className="label search-suggest-heading">Start here</h2>
              <PostGrid posts={suggestions} />
            </>
          )}

          {/* Renders nothing at all when the newsletter is switched off. */}
          <SubscribeSection />
        </>
      ) : (
        <>
          <p className="meta search-count">
            {results.length} {results.length === 1 ? "result" : "results"} for{" "}
            <strong>{query}</strong>
          </p>
          <PostGrid posts={results} />
        </>
      )}
    </div>
  );
}

/**
 * What to offer when there is nothing to show.
 *
 * The featured post leads — it is the one piece the author has explicitly
 * pointed at — and recent work fills the rest. Deliberately not called "best":
 * nothing here measures that, and a heading that claimed to would be inventing
 * a ranking out of publication order.
 */
async function suggestedReading(db: ReturnType<typeof getDb>): Promise<PostSummary[]> {
  try {
    const [featured, feed] = await Promise.all([
      getFeaturedPost(db),
      getFeed(db, 1),
    ]);

    const picks = featured ? [featured] : [];
    for (const post of feed.posts) {
      if (picks.length >= SUGGESTION_COUNT) break;
      if (post.slug !== featured?.slug) picks.push(post);
    }
    return picks;
  } catch {
    // The suggestions are a courtesy; the search box above still works.
    return [];
  }
}
