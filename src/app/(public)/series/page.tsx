import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { listPublishedSeries } from "@/lib/public-posts";
import { postListJsonLd } from "@/lib/structured-data";
import { JsonLd } from "@/components/public/JsonLd";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Series",
  description: "Pieces written to be read in order.",
  alternates: { canonical: "/series" },
};

/**
 * The series index.
 *
 * This route did not exist: `/series` was a 404, and a series was reachable
 * only from the "Part N of M" line on an article you had already found. A
 * sequence written to be read in order had no front door.
 */
export default async function SeriesIndexPage() {
  const series = await listPublishedSeries(getDb()).catch(() => []);

  return (
    <div className="shell-wrap" id="content">
      <JsonLd
        json={postListJsonLd(
          series.map((entry) => ({ title: entry.title, slug: `series/${entry.slug}` })),
          {
            name: "Series",
            path: "/series",
            description: "Pieces written to be read in order.",
          },
        )}
      />

      <div className="page-head">
        <p className="label">Reading in order</p>
        <h1>Series</h1>
        <p>
          {series.length === 0
            ? "Nothing is running in parts yet."
            : "Pieces written to be read in sequence, oldest first."}
        </p>
      </div>

      {series.length > 0 && (
        <ul className="series-index">
          {series.map((entry) => (
            <li key={entry.slug}>
              <Link href={`/series/${entry.slug}`} className="series-index-link">
                <span className="series-index-title">{entry.title}</span>
                <span className="meta">
                  {entry.count} {entry.count === 1 ? "part" : "parts"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="series-index-back">
        <Link href="/articles">Everything, newest first →</Link>
      </p>
    </div>
  );
}
