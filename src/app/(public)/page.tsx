import { getDb } from "@/db/client";
import { FeaturedPost } from "@/components/public/FeaturedPost";
import { HomeFeed } from "@/components/public/HomeFeed";
import { Pagination } from "@/components/public/Pagination";
import { Wordmark } from "@/components/public/Wordmark";
import { getFeaturedPost, getFeed } from "@/lib/public-posts";

/**
 * ISR. Rendered once and served from KV until a write invalidates it; the
 * hourly window is only a safety net in case an invalidation is ever missed.
 */
/*
  Five minutes rather than an hour.

  A publish from the admin invalidates these paths immediately, but a post
  *scheduled* for a future time has no write to hang that on — the moment it
  becomes public passes with no request to notice it. This window is what
  bounds the delay: a scheduled post joins the feed within five minutes of its
  time. Post pages keep the long window; see the note in [slug]/page.tsx.
*/
export const revalidate = 300;

export default async function HomePage() {
  const db = getDb();
  const [feed, featured] = await Promise.all([getFeed(db, 1), getFeaturedPost(db)]);

  // The lead post is shown above; repeating it in the grid directly beneath
  // reads as a duplicate rather than emphasis.
  const rest = featured
    ? feed.posts.filter((post) => post.slug !== featured.slug)
    : feed.posts;

  return (
    <div className="shell-wrap">
      <div className="hero">
        <Wordmark as="h1" />
      </div>

      {featured && <FeaturedPost post={featured} />}

      {/* With only the featured post to show, the filter row and its empty
          state would be furniture around nothing. */}
      {rest.length > 0 && <HomeFeed posts={rest} />}

      <Pagination page={feed.page} totalPages={feed.totalPages} />
    </div>
  );
}
