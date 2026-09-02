import Link from "next/link";
import type { PostSummary } from "@/lib/public-posts";
import { formatDate } from "@/lib/site";

/**
 * The lead item on the home page.
 *
 * A two-column split rather than text laid over the image: the cover art is
 * duotone and unpredictable, and type over it would need a scrim to stay
 * legible — which would be the one soft, gradient-y thing on an otherwise
 * hard-edged page. Side by side, the picture stays a picture and the words
 * stay readable.
 *
 * Without a cover it becomes a single wide column rather than leaving a hole,
 * so a post published without art still leads properly.
 */
export function FeaturedPost({ post }: { post: PostSummary }) {
  const primaryTag = post.tags[0];

  return (
    <article className={post.coverImageUrl ? "featured" : "featured featured--text"}>
      {post.coverImageUrl && (
        <Link href={`/${post.slug}`} className="featured-figure" tabIndex={-1} aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="duotone"
            src={post.coverImageUrl}
            alt=""
            // The lead image is above the fold on every visit; it should not
            // wait its turn behind anything else.
            fetchPriority="high"
            decoding="async"
          />
        </Link>
      )}

      <div className="featured-body">
        <div className="featured-top">
          <span className="label">Featured</span>
          {primaryTag && (
            <Link href={`/tag/${primaryTag.slug}`} className="tag-pill">
              {primaryTag.name}
            </Link>
          )}
        </div>

        <h2 className="featured-title">
          <Link href={`/${post.slug}`}>{post.title}</Link>
        </h2>

        {post.excerpt && <p className="featured-excerpt">{post.excerpt}</p>}

        <div className="meta featured-meta">
          <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
          <span className="meta-sep" aria-hidden="true">
            /
          </span>
          <span>{post.readingMinutes} min read</span>
        </div>

        <Link href={`/${post.slug}`} className="featured-more">
          Read this one →
        </Link>
      </div>
    </article>
  );
}
