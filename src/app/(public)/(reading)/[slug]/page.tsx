import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getDb } from "@/db/client";
import { CommentThread } from "@/components/public/CommentThread";
import { Wordmark } from "@/components/public/Wordmark";
import { getApprovedThread } from "@/lib/comments";
import {
  getPublishedPost,
  getRelatedPosts,
  listPublishedSlugs,
  readingMinutes,
} from "@/lib/public-posts";
import { getSeriesContext } from "@/lib/series";
import { absoluteUrl, formatDate, siteConfig } from "@/lib/site";

export const revalidate = 3600;

type Params = Promise<{ slug: string }>;

/**
 * Pre-renders every published post at build time when the database is
 * reachable. Anything not listed here — a post published after the build —
 * renders on first request and is cached from then on.
 */
export async function generateStaticParams() {
  try {
    const slugs = await listPublishedSlugs(getDb());
    return slugs.map((slug) => ({ slug }));
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
  const post = await getPublishedPost(getDb(), slug);
  if (!post) return { title: "Not found" };

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

  // getPublishedPost filters on status, so a draft is indistinguishable from a
  // slug that does not exist — both are a real 404, not a soft error page.
  const post = await getPublishedPost(db, slug);
  if (!post) notFound();

  const [seriesContext, comments, related] = await Promise.all([
    getSeriesContext(db, { id: post.id, seriesId: post.series_id }),
    getApprovedThread(db, post.id),
    getRelatedPosts(db, post),
  ]);

  const published = post.published_at ?? post.created_at;

  return (
    <div className="article-layout shell-wrap" id="content">
      <article className="article">
        {post.cover_image_url && (
          /*
            Contained rather than full-bleed. Design.md §6 left this open
            ("evaluate both at implementation time"); the reference screenshot
            settles it — a contained cover keeps the image inside the same
            column as the words, which reads calmer over long-form text.
          */
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="article-cover"
            src={post.cover_image_url}
            alt=""
            fetchPriority="high"
          />
        )}

        <header className="article-head">
          {seriesContext && (
            <Link
              href={`/series/${seriesContext.series.slug}`}
              className="article-series"
            >
              Part {seriesContext.part} of {seriesContext.total} ·{" "}
              {seriesContext.series.title}
            </Link>
          )}

          <h1 className="article-title">{post.title}</h1>

          <div className="byline">
            <span className="byline-avatar" aria-hidden="true">
              {siteConfig.author.slice(0, 1)}
            </span>
            <span className="byline-text">
              <span className="byline-name">
                Written by {siteConfig.author}
              </span>
              <span className="byline-meta">
                <time dateTime={published}>{formatDate(published)}</time>
                {" · "}
                {readingMinutes(post.content_html)} min read
              </span>
            </span>
          </div>

          {post.tags.length > 0 && (
            <div className="article-tags">
              {post.tags.map((tag) => (
                <Link
                  key={tag.slug}
                  href={`/tag/${tag.slug}`}
                  className="tag-pill tag-pill--quiet"
                >
                  {tag.name}
                </Link>
              ))}
            </div>
          )}
        </header>

        {/*
          content_html is produced by Tiptap's own serializer from this blog's
          single trusted author, and the schema admits no raw HTML nodes — so
          this is rendering our own output, not reader input.
        */}
        <div
          className="prose"
          dangerouslySetInnerHTML={{ __html: post.content_html ?? "" }}
        />

        <CommentThread postId={post.id} comments={comments} />
      </article>

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
          </section>
        )}

        <section className="aside-block">
          <h2 className="aside-title">More from {siteConfig.name}</h2>
          <Link href="/stories" className="aside-more">
            See all stories →
          </Link>
        </section>
      </aside>
    </div>
  );
}
