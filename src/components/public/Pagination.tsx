import Link from "next/link";

/**
 * Numbered pages rather than infinite scroll: every page is its own URL, so it
 * can be statically cached, linked, and crawled, and it works with JavaScript
 * off. Infinite scroll would need client state and a fetch waterfall for
 * content that is otherwise fully static.
 */
export function Pagination({
  page,
  totalPages,
  basePath = "",
}: {
  page: number;
  totalPages: number;
  basePath?: string;
}) {
  if (totalPages <= 1) return null;

  const href = (target: number) =>
    target === 1 ? basePath || "/" : `${basePath}/page/${target}`;

  return (
    <nav className="pagination" aria-label="Pagination">
      {page > 1 ? (
        <Link href={href(page - 1)} rel="prev">
          ← Newer
        </Link>
      ) : (
        <span />
      )}
      <span className="pagination-position">
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={href(page + 1)} rel="next">
          Older →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
