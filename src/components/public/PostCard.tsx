import Link from "next/link";
import type { PostSummary } from "@/lib/public-posts";
import { formatDate } from "@/lib/site";

/**
 * One cell of the grid (Design.md §5): tag, cover, title, two-line excerpt,
 * metadata.
 *
 * §5 lists the date twice — once in the top row and again in the metadata row,
 * an artefact of adapting the reference's byline credit line. Printing it
 * twice on one card reads as a bug, so it appears once, in the metadata row
 * where the reading time is.
 */
export function PostCard({ post }: { post: PostSummary }) {
  const primaryTag = post.tags[0];

  return (
    <article className="grid-item" data-tags={post.tags.map((t) => t.slug).join(" ")}>
      <Link href={`/${post.slug}`} className="card-link">
        {post.coverImageUrl && (
          <figure className="card-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="duotone"
              src={post.coverImageUrl}
              alt=""
              loading="lazy"
              decoding="async"
            />
          </figure>
        )}
      </Link>

      {primaryTag && (
        <div className="card-top">
          <Link href={`/tag/${primaryTag.slug}`} className="tag-pill">
            {primaryTag.name}
          </Link>
        </div>
      )}

      <Link href={`/${post.slug}`} className="card-link">
        <h2 className="card-title">{post.title}</h2>
      </Link>

      {post.excerpt && <p className="card-excerpt">{post.excerpt}</p>}

      <div className="meta card-meta">
        <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
        <span className="meta-sep" aria-hidden="true">
          /
        </span>
        <span>{post.readingMinutes} min read</span>
      </div>
    </article>
  );
}
