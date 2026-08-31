import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { PostGrid } from "@/components/public/PostGrid";
import { Pagination } from "@/components/public/Pagination";
import { getFeed } from "@/lib/public-posts";

/* Five-minute window so scheduled posts surface promptly — see app/(public)/page.tsx. */
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Articles",
  description: "Everything published, newest first.",
  alternates: { canonical: "/articles" },
};

/** The archive the nav's "Articles" link points at. */
export default async function ArticlesPage() {
  const feed = await getFeed(getDb(), 1);

  return (
    <div className="shell-wrap" id="content">
      <div className="page-head">
        <p className="label">Archive</p>
        <h1>Articles</h1>
        <p>
          {feed.totalPosts} {feed.totalPosts === 1 ? "article" : "articles"}, newest
          first
        </p>
      </div>
      <PostGrid posts={feed.posts} />
      <Pagination page={feed.page} totalPages={feed.totalPages} />
    </div>
  );
}
