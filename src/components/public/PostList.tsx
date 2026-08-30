import Link from "next/link";
import type { PostSummary } from "@/lib/public-posts";
import { PostMeta } from "./PostMeta";

/**
 * The feed layout, shared by the home page and tag pages.
 *
 * Plain <img> rather than next/image: covers already live in R2 at the size
 * the author uploaded, and the image optimizer would add a Worker dependency
 * for no gain here. The 2:1 box is set in CSS so the row does not jump as
 * images arrive.
 */
export function PostList({ posts }: { posts: PostSummary[] }) {
  return (
    <ul className="feed">
      {posts.map((post) => (
        <li key={post.slug} className="feed-item">
          <article>
            {post.coverImageUrl && (
              <Link href={`/${post.slug}`} tabIndex={-1} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="feed-cover"
                  src={post.coverImageUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              </Link>
            )}
            <h2 className="feed-item-title">
              <Link href={`/${post.slug}`}>{post.title}</Link>
            </h2>
            {post.excerpt && <p className="feed-item-excerpt">{post.excerpt}</p>}
            <PostMeta
              publishedAt={post.publishedAt}
              readingMinutes={post.readingMinutes}
              tags={post.tags}
            />
          </article>
        </li>
      ))}
    </ul>
  );
}
