import Link from "next/link";
import type { ReactNode } from "react";
import type { SerializedPost } from "@/lib/posts";
import { readingMinutes } from "@/lib/public-posts";
import type { SeriesContext } from "@/lib/series";
import { absoluteUrl, formatDate, siteConfig } from "@/lib/site";

/**
 * The post itself — cover, head, prose.
 *
 * Shared by the public post page and the draft preview so a preview shows
 * exactly what will publish, rather than a second rendering that can drift.
 *
 * Marked up as an `h-entry` microformat. That is a second, independent way of
 * saying what the JSON-LD already says — and it is worth having both, because
 * they are read by different things: JSON-LD by search engines, microformats
 * by feed readers, IndieWeb tooling and anything that federates a page by
 * parsing it rather than by asking an API. The classes hang off elements that
 * exist anyway, so nothing is added to the markup for their sake alone.
 */
export function Article({
  post,
  seriesContext,
  children,
}: {
  post: SerializedPost;
  seriesContext?: SeriesContext | null;
  /** Comments, appended inside the article on the public page. */
  children?: ReactNode;
}) {
  const published = post.published_at ?? post.created_at;

  return (
    <article className="article h-entry">
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
            className="label article-series"
          >
            Part {seriesContext.part} of {seriesContext.total} ·{" "}
            {seriesContext.series.title}
          </Link>
        )}

        <h1 className="article-title p-name">{post.title}</h1>

        {post.excerpt && <p className="p-summary" hidden>{post.excerpt}</p>}

        <div className="byline">
          <span className="byline-avatar" aria-hidden="true">
            {siteConfig.author.slice(0, 1)}
          </span>
          <span className="byline-text">
            {/* A nested h-card: the author of this entry, not of the site. */}
            <span className="byline-name p-author h-card">
              Written by{" "}
              <a className="p-name u-url" href={absoluteUrl("/about")} rel="author">
                {siteConfig.author}
              </a>
            </span>
            <span className="byline-meta">
              <time className="dt-published" dateTime={published}>
                {formatDate(published)}
              </time>
              {" · "}
              {readingMinutes(post.content_html)} min read
            </span>
          </span>
        </div>

        {/*
          The entry's own permalink, which a parser needs to attribute the
          content to a URL. Hidden from view — the reader is already on it —
          but present in the markup, which is what a consumer reads.
        */}
        <a className="u-url u-uid" href={absoluteUrl(`/${post.slug}`)} hidden>
          {post.title}
        </a>

        {post.tags.length > 0 && (
          <div className="article-tags">
            {post.tags.map((tag) => (
              <Link
                key={tag.slug}
                href={`/tag/${tag.slug}`}
                className="tag-pill p-category"
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
        className="prose e-content"
        dangerouslySetInnerHTML={{ __html: post.content_html ?? "" }}
      />

      {children}
    </article>
  );
}
