import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { PostGrid } from "@/components/public/PostGrid";
import { Pagination } from "@/components/public/Pagination";
import { getFeed } from "@/lib/public-posts";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Stories",
  description: "Everything published, newest first.",
  alternates: { canonical: "/stories" },
};

/** The archive the nav's "Stories" link points at. */
export default async function StoriesPage() {
  const feed = await getFeed(getDb(), 1);

  return (
    <div className="shell-wrap" id="content">
      <div className="page-head">
        <p className="label">Archive</p>
        <h1>Stories</h1>
        <p>
          {feed.totalPosts} {feed.totalPosts === 1 ? "story" : "stories"}, newest
          first
        </p>
      </div>
      <PostGrid posts={feed.posts} />
      <Pagination page={feed.page} totalPages={feed.totalPages} />
    </div>
  );
}
