import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { SeriesArchive } from "@/components/public/archives";
import { getSeriesBySlug } from "@/lib/series";

export const revalidate = 300;

type Params = Promise<{ slug: string; page: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { slug, page } = await params;
  const found = await getSeriesBySlug(getDb(), slug);
  if (!found) return { title: "Not found" };
  return {
    title: `${found.title} — page ${page}`,
    alternates: { canonical: `/series/${slug}` },
  };
}

export default async function SeriesPageN({ params }: { params: Params }) {
  const { slug, page } = await params;
  const parsed = Number(page);

  if (!Number.isInteger(parsed) || parsed < 1) notFound();
  if (parsed === 1) redirect(`/series/${slug}`);

  return <SeriesArchive slug={slug} page={parsed} />;
}
