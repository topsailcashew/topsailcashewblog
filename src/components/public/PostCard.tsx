import Link from "next/link";
import type { PostSummary } from "@/lib/public-posts";
import { formatDate } from "@/lib/site";
import { Wordmark } from "./Wordmark";

/**
 * One cell of the grid, in the exact order Design.md §5 sets out:
 * date + tag pill, cover, title, two-line excerpt, metadata row.
 *
 * The date appears in both the top row and the metadata row because §5 lists
 * it in both — the bottom row is the reference's credit line with the byline
 * dropped (§9).
 */
export function PostCard({ post }: { post: PostSummary }) {
  const primaryTag = post.tags[0];

  return (
    <article className="grid-item" data-tags={post.tags.map((t) => t.slug).join(" ")}>
      <div className="card-top">
        <span className="card-date">{formatDate(post.publishedAt)}</span>
        {primaryTag && (
          <Link href={`/tag/${primaryTag.slug}`} className="tag-pill tag-pill--quiet">
            {primaryTag.name}
          </Link>
        )}
      </div>

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
        <Wordmark as="h2" scale="card" className="card-title">
          {post.title}
        </Wordmark>
      </Link>

      {post.excerpt && <p className="card-excerpt">{post.excerpt}</p>}

      <div className="card-meta">
        <span>{formatDate(post.publishedAt)}</span>
        <span className="card-meta-dot" aria-hidden="true">
          —
        </span>
        <span>{post.readingMinutes} min read</span>
      </div>
    </article>
  );
}
