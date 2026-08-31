import Link from "next/link";
import { getDb } from "@/db/client";
import { listPages, type SerializedPage } from "@/lib/pages";

export const dynamic = "force-dynamic";

/**
 * Standalone pages — the four the nav links to, plus any others.
 *
 * The nav links to /about, /newsletter and /contact unconditionally, so a
 * missing or unpublished page shows up here as the thing to fix.
 */
export default async function AdminPagesPage() {
  let pages: SerializedPage[] = [];
  let error: string | null = null;
  try {
    pages = await listPages(getDb());
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  const linked = new Set(pages.map((page) => page.slug));

  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Pages</h1>
        <Link href="/admin/pages/new" className="btn btn--primary btn--small">
          New page
        </Link>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!error && (
        <>
          {NAV_SLUGS.filter((slug) => !linked.has(slug)).map((slug) => (
            <p key={slug} className="hint">
              The nav links to /{slug}, but no page has that slug yet.{" "}
              <Link href="/admin/pages/new">Create it.</Link>
            </p>
          ))}

          {pages.length === 0 && (
            <p className="muted">
              No pages yet. <Link href="/admin/pages/new">Write the first one.</Link>
            </p>
          )}

          <ul className="post-rows">
            {pages.map((page) => (
              <li key={page.id}>
                <div className="post-row-head">
                  <Link href={`/admin/pages/${page.id}`} className="post-row-title">
                    {page.title}
                  </Link>
                  <span className={`status--${page.status}`}>{page.status}</span>
                </div>
                <p className="meta">
                  /{page.slug} · updated {new Date(page.updated_at).toLocaleString()}
                  {page.status === "published" && (
                    <>
                      {" · "}
                      <Link href={`/${page.slug}`}>View</Link>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

/** Kept in step with NAV_LINKS in src/components/public/SiteChrome.tsx. */
const NAV_SLUGS = ["about", "newsletter", "contact"] as const;
