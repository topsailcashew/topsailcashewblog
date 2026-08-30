import { getDb } from "@/db/client";
import { PostList } from "@/components/public/PostList";
import { Pagination } from "@/components/public/Pagination";
import { getFeed } from "@/lib/public-posts";
import { siteConfig } from "@/lib/site";

/**
 * ISR. Rendered once and served from KV until a write invalidates it (see
 * `src/lib/revalidate.ts`); the hourly window is only a safety net in case an
 * invalidation is ever missed.
 */
export const revalidate = 3600;

export default async function HomePage() {
  const feed = await getFeed(getDb(), 1);

  return (
    <div className="wrap">
      <div className="feed-intro">
        <h1>{siteConfig.name}</h1>
        <p>{siteConfig.description}</p>
      </div>

      {feed.posts.length === 0 ? (
        <p className="notice">Nothing published yet.</p>
      ) : (
        <>
          <PostList posts={feed.posts} />
          <Pagination page={feed.page} totalPages={feed.totalPages} />
        </>
      )}
    </div>
  );
}
