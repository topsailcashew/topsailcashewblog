import { getDb } from "@/db/client";
import { HomeFeed } from "@/components/public/HomeFeed";
import { Pagination } from "@/components/public/Pagination";
import { Wordmark } from "@/components/public/Wordmark";
import { getFeed } from "@/lib/public-posts";

/**
 * ISR. Rendered once and served from KV until a write invalidates it; the
 * hourly window is only a safety net in case an invalidation is ever missed.
 */
export const revalidate = 3600;

export default async function HomePage() {
  const feed = await getFeed(getDb(), 1);

  return (
    <div className="shell-wrap">
      <div className="hero">
        <Wordmark as="h1" />
      </div>

      <HomeFeed posts={feed.posts} />

      <Pagination page={feed.page} totalPages={feed.totalPages} />
    </div>
  );
}
