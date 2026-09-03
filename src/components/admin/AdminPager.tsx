import Link from "next/link";

/**
 * Prev/next for an admin list.
 *
 * Every admin list was capped and none of them said so: Articles fetched 100
 * with a hard-coded `offset: 0`, Media rendered "84 images" while showing 60,
 * and Subscribers printed `Everyone · {rows.length}` — the truncated count
 * dressed up as the total. A cap with no pager is not a limit, it is a silent
 * loss.
 *
 * Query-string paging rather than nested routes: these screens already carry
 * `?status=` and `?q=`, and a filter has to survive turning the page.
 */
export function AdminPager({
  page,
  total,
  perPage,
  basePath,
  params = {},
  noun,
}: {
  page: number;
  total: number;
  perPage: number;
  basePath: string;
  /** Filters to carry across, e.g. `{ status: "draft", q: "ada" }`. */
  params?: Record<string, string | undefined>;
  noun: string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  /*
    A hand-typed `?page=` can point past the end. Without this the range runs
    backwards — "26–22 of 22" — which is worse than saying nothing, because it
    looks like a counting bug rather than a page that is not there.
  */
  const beyondEnd = page > totalPages;
  const first = total === 0 || beyondEnd ? 0 : (page - 1) * perPage + 1;
  const last = beyondEnd ? 0 : Math.min(page * perPage, total);

  const href = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    if (target > 1) search.set("page", String(target));
    const query = search.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  return (
    <nav className="admin-pager" aria-label={`${noun} pages`}>
      <span className="meta">
        {total === 0
          ? `No ${noun}`
          : beyondEnd
            ? `Nothing on page ${page} — there ${totalPages === 1 ? "is" : "are"} ${totalPages} ${totalPages === 1 ? "page" : "pages"}`
            : `${first}–${last} of ${total} ${noun}`}
      </span>
      {(totalPages > 1 || beyondEnd) && (
        <span className="row row--tight">
          {page > 1 ? (
            <Link
              href={href(beyondEnd ? totalPages : page - 1)}
              className="btn btn--quiet btn--small"
              rel="prev"
            >
              ← {beyondEnd ? "Back to the last page" : "Previous"}
            </Link>
          ) : (
            <span />
          )}
          <span className="meta">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={href(page + 1)} className="btn btn--quiet btn--small" rel="next">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </span>
      )}
    </nav>
  );
}

/** `?page=` as a positive integer, defaulting to 1. */
export function parsePage(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}
