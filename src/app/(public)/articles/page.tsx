import type { Metadata } from "next";
import { ArticlesArchive } from "@/components/public/archives";

/* Five-minute window so scheduled posts surface promptly — see app/(public)/page.tsx. */
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Articles",
  description: "Everything published, newest first.",
  alternates: { canonical: "/articles" },
};

/** The archive the nav's "Articles" link points at. */
export default async function ArticlesPage() {
  return <ArticlesArchive page={1} />;
}
