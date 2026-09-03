import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { SubscribeForm } from "@/components/public/SubscribeForm";
import { loadNewsletterSettings } from "@/lib/email/config";
import { getFeed } from "@/lib/public-posts";
import { PostGrid } from "@/components/public/PostGrid";

/*
  ISR, not `force-dynamic`, and that is load-bearing.

  A `force-dynamic` page is not prerendered — so at build time `/[slug]`'s
  `generateStaticParams` claimed `/newsletter` for the seeded database page
  instead, and every request 500d with "Page with `dynamic = force-dynamic`
  won't be rendered statically". Being prerenderable is what makes the file
  route win the path. `/about` is the same arrangement for the same reason.

  Settings changes invalidate this path immediately (see `PUT /api/settings`),
  so the window is not a staleness window.
*/
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Newsletter",
  description: "New writing by email, sent when a piece is finished.",
  alternates: { canonical: "/newsletter" },
};

/**
 * The signup page.
 *
 * A filesystem route, which wins over the database page of the same slug —
 * the same arrangement `/about` already uses. It replaces a seeded page whose
 * body read "There is no mailing list yet… Subscribe at /rss.xml": static
 * copy that never consulted settings, so it went on saying that after the
 * newsletter was switched on. This page reads the setting, so it cannot say
 * the wrong thing.
 *
 * With the newsletter off it does not pretend RSS is a mailing list; it says
 * there is no list and points at the feed as what there is.
 */
export default async function NewsletterPage() {
  const db = getDb();
  const settings = await loadNewsletterSettings(db).catch(() => null);
  const enabled = settings?.enabled ?? false;

  // Three recent pieces, so the page shows what subscribing would have got you
  // rather than describing it.
  const feed = enabled ? await getFeed(db, 1).catch(() => null) : null;
  const recent = feed?.posts.slice(0, 3) ?? [];

  return (
    <div className="shell-wrap" id="content">
      <div className="page-head">
        <p className="label">By email</p>
        <h1>Newsletter</h1>
        <p>{settings?.pitch ?? "New writing, sent when it is finished."}</p>
      </div>

      {enabled ? (
        <>
          <SubscribeForm pitch={settings?.pitch ?? ""} />

          <div className="newsletter-terms">
            <h2 className="label">What arrives</h2>
            <ul>
              <li>The whole piece, not a teaser with a link to the rest.</li>
              <li>Only when something is finished. There is no schedule to fill.</li>
              <li>
                One click to confirm and one to leave — the unsubscribe link is
                in every email and it works.
              </li>
              <li>
                Nothing is shared or sold. The only thing measured is whether an
                email was opened.
              </li>
            </ul>
          </div>

          {recent.length > 0 && (
            <>
              <h2 className="label newsletter-recent-heading">
                The last few, so you know what you are signing up to
              </h2>
              <PostGrid posts={recent} />
            </>
          )}
        </>
      ) : (
        <div className="notice">
          <p>
            There is no mailing list running at the moment. The{" "}
            <a href="/rss.xml">RSS feed</a> carries every post in full and works
            in any reader — no account, no address, nothing to unsubscribe from.
          </p>
          <p>
            <Link href="/articles">Read the archive instead →</Link>
          </p>
        </div>
      )}
    </div>
  );
}
