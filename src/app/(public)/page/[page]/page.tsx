import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { PostList } from "@/components/public/PostList";
import { Pagination } from "@/components/public/Pagination";
import { getFeed } from "@/lib/public-posts";

export const revalidate = 3600;

type Params = Promise<{ page: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { page } = await params;
  return { title: `Page ${page}` };
}

/** Pre-renders the pages that exist today; later ones render on first request. */
export async function generateStaticParams() {
  try {
    const { totalPages } = await getFeed(getDb(), 1);
    return Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => ({
      page: String(index + 2),
    }));
  } catch {
    // A build without database access still succeeds; pages fill in lazily.
    return [];
  }
}

export default async function FeedPage({ params }: { params: Params }) {
  const { page } = await params;
  const parsed = Number(page);

  if (!Number.isInteger(parsed) || parsed < 1) notFound();
  // /page/1 is the same content as /; keep one canonical URL for it.
  if (parsed === 1) redirect("/");

  const feed = await getFeed(getDb(), parsed);
  if (feed.posts.length === 0) notFound();

  return (
    <div className="wrap">
      <PostList posts={feed.posts} />
      <Pagination page={feed.page} totalPages={feed.totalPages} />
    </div>
  );
}
