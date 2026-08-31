import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { PostGrid } from "@/components/public/PostGrid";
import { getFeed, getTagName, listPublishedTagSlugs } from "@/lib/public-posts";

/* Five-minute window so scheduled posts surface promptly — see app/(public)/page.tsx. */
export const revalidate = 300;

type Params = Promise<{ tag: string }>;

export async function generateStaticParams() {
  try {
    const slugs = await listPublishedTagSlugs(getDb());
    return slugs.map((tag) => ({ tag }));
  } catch {
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { tag } = await params;
  const name = await getTagName(getDb(), tag);
  if (!name) return { title: "Not found" };
  return {
    title: `${name}`,
    description: `Posts tagged ${name}.`,
    alternates: { canonical: `/tag/${tag}` },
  };
}

export default async function TagPage({ params }: { params: Params }) {
  const { tag } = await params;

  // A tag with no published posts 404s rather than rendering an empty page:
  // it is indistinguishable from a tag that never existed, and an empty page
  // is something search engines would index for no reason.
  const name = await getTagName(getDb(), tag);
  if (!name) notFound();

  const feed = await getFeed(getDb(), 1, tag);
  if (feed.posts.length === 0) notFound();

  return (
    // Same 3-column grid as the homepage (§7).
    <div className="shell-wrap" id="content">
      <div className="page-head">
        <p className="label">Tagged</p>
        <h1>{name}</h1>
        <p>
          {feed.totalPosts} {feed.totalPosts === 1 ? "post" : "posts"}
        </p>
      </div>
      <PostGrid posts={feed.posts} />
    </div>
  );
}
