import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { TagArchive } from "@/components/public/archives";
import { getTagName, listPublishedTagSlugs } from "@/lib/public-posts";

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
  return <TagArchive tag={tag} page={1} />;
}
