import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { JsonLd } from "@/components/public/JsonLd";
import { PostGrid } from "@/components/public/PostGrid";
import { Pagination } from "@/components/public/Pagination";
import { getFeed } from "@/lib/public-posts";
import { postListJsonLd } from "@/lib/structured-data";

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
      {/* The archive as an ItemList, so a crawler reads it as a list of
          articles rather than as a page that happens to contain links. */}
      <JsonLd
        json={postListJsonLd(feed.posts, {
          name: "Articles",
          path: "/articles",
          description: "Everything published, newest first.",
        })}
      />
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
