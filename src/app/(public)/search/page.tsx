import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { PostGrid } from "@/components/public/PostGrid";
import { searchPublished } from "@/lib/public-posts";

/** Results depend on the query string, so there is nothing to pre-render. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Search",
  // A results page has no business in an index.
  robots: { index: false, follow: true },
};

type SearchParams = Promise<{ q?: string }>;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  let results: Awaited<ReturnType<typeof searchPublished>> = [];
  let failed = false;
  if (query !== "") {
    try {
      results = await searchPublished(getDb(), query);
    } catch {
      // websearch_to_tsquery tolerates almost anything, but a malformed query
      // should read as "no results", never as a stack trace.
      failed = true;
    }
  }

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

      {query === "" ? (
        <p className="notice">Type something above to search the archive.</p>
      ) : failed ? (
        <p className="notice">That search could not be run. Try simpler terms.</p>
      ) : results.length === 0 ? (
        <p className="notice">
          Nothing matches <strong>{query}</strong>.
        </p>
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
