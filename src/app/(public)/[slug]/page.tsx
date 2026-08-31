import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getDb } from "@/db/client";
import { Article } from "@/components/public/Article";
import { CommentThread } from "@/components/public/CommentThread";
import { JsonLd } from "@/components/public/JsonLd";
import { getApprovedThread } from "@/lib/comments";
import { getPublishedPage, listPublishedPageSlugs } from "@/lib/pages";
import {
  getPublishedPost,
  getRelatedPosts,
  listPublishedSlugs,
} from "@/lib/public-posts";
import { getSeriesContext } from "@/lib/series";
import { absoluteUrl, formatDate, siteConfig } from "@/lib/site";
import { articleJsonLd, pageJsonLd } from "@/lib/structured-data";

/*
  Five minutes, matching the list pages.

  It is tempting to cache a post's own URL for longer — it changes rarely. But
  a scheduled post's slug returns a 404 until its time arrives, and that 404
  is cached like any other response. Whoever visits the URL early (the author,
  most likely, checking their own link) pins it there for the length of this
  window. Opting that one render out of the cache is not available: calling a
  dynamic API from a route that declares `revalidate` is an error, not a
  fallback. So the window itself is the bound, and it is the same five minutes
  promised everywhere else.
*/
export const revalidate = 300;

type Params = Promise<{ slug: string }>;

/**
 * Pre-renders every published post and page at build time when the database is
 * reachable. Anything not listed here — a post published after the build, or
 * one that was scheduled — renders on first request and is cached from then on.
 */
export async function generateStaticParams() {
  try {
    const db = getDb();
    const [postSlugs, pageSlugs] = await Promise.all([
      listPublishedSlugs(db),
      listPublishedPageSlugs(db),
    ]);
    return [...postSlugs, ...pageSlugs].map((slug) => ({ slug }));
  } catch {
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  const db = getDb();
  const post = await getPublishedPost(db, slug);

  if (!post) {
    const page = await getPublishedPage(db, slug);
    if (!page) return { title: "Not found" };
    return {
      title: page.title,
      description: siteConfig.description,
      alternates: { canonical: `/${page.slug}` },
      openGraph: {
        type: "website",
        title: page.title,
        url: absoluteUrl(`/${page.slug}`),
        images: [{ url: absoluteUrl("/og/default.png"), width: 1200, height: 630 }],
      },
    };
  }

  const description = post.excerpt ?? siteConfig.description;
  return {
    title: post.title,
    description,
    alternates: { canonical: `/${post.slug}` },
    twitter: { card: "summary_large_image" },
    openGraph: {
      type: "article",
      title: post.title,
      description,
      url: absoluteUrl(`/${post.slug}`),
      publishedTime: post.published_at ?? undefined,
      /*
        Cards are rendered into /public/og at build time — see
        scripts/generate-og-images.ts for why they are not generated in the
        Worker. The site-wide card is listed second so a post published since
        the last deploy still has something to show.
      */
      images: [
        { url: absoluteUrl(`/og/${post.slug}.png`), width: 1200, height: 630 },
        { url: absoluteUrl("/og/default.png"), width: 1200, height: 630 },
      ],
    },
  };
}

export default async function PostPage({ params }: { params: Params }) {
  const { slug } = await params;
  const db = getDb();

  // getPublishedPost filters on status *and* publication time, so a draft, a
  // post scheduled for later, and a slug that does not exist are all
  // indistinguishable here — each is a real 404, not a soft error page.
  const post = await getPublishedPost(db, slug);
  if (!post) return renderPage(db, slug);

  const [seriesContext, comments, related] = await Promise.all([
    getSeriesContext(db, { id: post.id, seriesId: post.series_id }),
    getApprovedThread(db, post.id),
    getRelatedPosts(db, post),
  ]);

  return (
    <div className="article-layout shell-wrap" id="content">
      <JsonLd json={articleJsonLd(post)} />

      <Article post={post} seriesContext={seriesContext}>
        <CommentThread postId={post.id} comments={comments} />
      </Article>

      <aside className="article-aside" aria-label="More reading">
        {related.length > 0 && (
          <section className="aside-block">
            <h2 className="aside-title">Read Next</h2>
            <ul className="aside-list">
              {related.map((item) => (
                <li key={item.slug}>
                  <Link href={`/${item.slug}`} className="aside-item">
                    {item.coverImageUrl && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        className="aside-thumb"
                        src={item.coverImageUrl}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <span>
                      <span className="aside-item-title">{item.title}</span>
                      <span className="aside-item-meta">
                        {formatDate(item.publishedAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <Link href="/articles" className="aside-more">
              See all articles →
            </Link>
          </section>
        )}
      </aside>
    </div>
  );
}

/**
 * The same URL space serves standalone pages — About, Newsletter, Contact.
 * Posts win, so a page can never shadow one; `findAvailableSlug` keeps the two
 * namespaces from colliding in the first place.
 */
async function renderPage(db: ReturnType<typeof getDb>, slug: string) {
  const page = await getPublishedPage(db, slug);
  if (!page) notFound();

  return (
    <div className="page-layout shell-wrap" id="content">
      <JsonLd json={pageJsonLd(page)} />
      <article className="article article--page">
        <header className="article-head">
          <h1 className="article-title">{page.title}</h1>
        </header>
        <div
          className="prose"
          dangerouslySetInnerHTML={{ __html: page.content_html ?? "" }}
        />
      </article>
    </div>
  );
}
