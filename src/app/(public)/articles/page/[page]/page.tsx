import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { ArticlesArchive } from "@/components/public/archives";
import { getFeed } from "@/lib/public-posts";

export const revalidate = 300;

type Params = Promise<{ page: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { page } = await params;
  return {
    title: `Articles — page ${page}`,
    // Page 2 onwards is the same set of articles in a different slice; the
    // canonical is the archive itself.
    alternates: { canonical: "/articles" },
  };
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

export default async function ArticlesPageN({ params }: { params: Params }) {
  const { page } = await params;
  const parsed = Number(page);

  if (!Number.isInteger(parsed) || parsed < 1) notFound();
  // Page 1 is the same content as /articles; keep one canonical URL for it.
  if (parsed === 1) redirect("/articles");

  return <ArticlesArchive page={parsed} />;
}
