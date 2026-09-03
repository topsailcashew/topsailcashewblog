import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { TagArchive } from "@/components/public/archives";
import { getTagName } from "@/lib/public-posts";

export const revalidate = 300;

type Params = Promise<{ tag: string; page: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { tag, page } = await params;
  const name = await getTagName(getDb(), tag);
  if (!name) return { title: "Not found" };
  return { title: `${name} — page ${page}`, alternates: { canonical: `/tag/${tag}` } };
}

/*
  Deliberately not pre-rendered. The cross product of every tag and every page
  is a build-time query per tag for a set of pages most tags do not have; these
  render on first request and are cached from then on like any other page.
*/

export default async function TagPageN({ params }: { params: Params }) {
  const { tag, page } = await params;
  const parsed = Number(page);

  if (!Number.isInteger(parsed) || parsed < 1) notFound();
  if (parsed === 1) redirect(`/tag/${tag}`);

  return <TagArchive tag={tag} page={parsed} />;
}
