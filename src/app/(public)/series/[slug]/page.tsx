import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { SeriesArchive } from "@/components/public/archives";
import { listPublishedSeriesSlugs } from "@/lib/public-posts";
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
  return <SeriesArchive slug={slug} page={1} />;
}
