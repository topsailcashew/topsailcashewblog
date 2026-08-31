import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { PostGrid } from "@/components/public/PostGrid";
import { getSeriesPosts, listPublishedSeriesSlugs } from "@/lib/public-posts";
import { getSeriesBySlug } from "@/lib/series";

/* Five-minute window so scheduled posts surface promptly — see app/(public)/page.tsx. */
export const revalidate = 300;

type Params = Promise<{ slug: string }>;

export async function generateStaticParams() {
  try {
    const slugs = await listPublishedSeriesSlugs(getDb());
    return slugs.map((slug) => ({ slug }));
  } catch {
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  const found = await getSeriesBySlug(getDb(), slug);
  if (!found) return { title: "Not found" };
  return {
    title: found.title,
    description: found.description ?? `Posts in the ${found.title} series.`,
    alternates: { canonical: `/series/${slug}` },
  };
}

export default async function SeriesPage({ params }: { params: Params }) {
  const { slug } = await params;
  const db = getDb();

  const found = await getSeriesBySlug(db, slug);
  if (!found) notFound();

  // A series with nothing published yet is not something to show a reader.
  const posts = await getSeriesPosts(db, slug);
  if (posts.length === 0) notFound();

  return (
    <div className="shell-wrap" id="content">
      <div className="page-head">
        <p className="label">Series</p>
        <h1>{found.title}</h1>
        {found.description && <p>{found.description}</p>}
        <p>
          {posts.length} {posts.length === 1 ? "part" : "parts"}, in reading order
        </p>
      </div>
      <PostGrid posts={posts} />
    </div>
  );
}
