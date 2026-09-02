import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { JsonLd } from "@/components/public/JsonLd";
import { getPublishedPage } from "@/lib/pages";
import { listProminentTags } from "@/lib/public-posts";
import { pageJsonLd } from "@/lib/structured-data";
import { siteConfig } from "@/lib/site";

/**
 * A dedicated route rather than the database-backed `/[slug]` one, because
 * this page has a layout of its own: a stated greeting in display type with a
 * cut-out portrait laid over it.
 *
 * The page row is still what supplies the prose underneath, so the copy stays
 * editable in the admin — only the arrangement is fixed here. The portrait is
 * the page's cover image, so that is editable too.
 */
export const revalidate = 300;

const SLUG = "about";

export async function generateMetadata(): Promise<Metadata> {
  const page = await getPublishedPage(getDb(), SLUG);
  if (!page) return { title: "About" };
  return {
    title: page.title,
    description: `About ${siteConfig.author}.`,
    alternates: { canonical: `/${SLUG}` },
  };
}

export default async function AboutPage() {
  const db = getDb();
  const [page, tags] = await Promise.all([
    getPublishedPage(db, SLUG),
    listProminentTags(db, 5),
  ]);

  // Unpublishing the page takes the route with it, rather than leaving a
  // headline with nothing behind it.
  if (!page) notFound();

  return (
    <div className="shell-wrap about">
      <JsonLd json={pageJsonLd(page)} />

      <header className={page.cover_image_url ? "about-hero" : "about-hero about-hero--bare"}>
        {/*
          Two lines, the second stroked rather than filled. The words are one
          sentence, so they are one heading with a line break in it — not two
          headings, which is what it would look like to a screen reader.
        */}
        <h1 className="about-statement">
          <span className="about-line">Hi, I&rsquo;m</span>
          <span className="about-line about-line--outline">Nate.</span>
        </h1>

        {page.cover_image_url && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="about-portrait"
            src={page.cover_image_url}
            alt={siteConfig.author}
            fetchPriority="high"
            decoding="async"
          />
        )}
      </header>

      <div className="about-under">
        <div className="about-actions">
          <Link href="/articles" className="btn btn--primary">
            Read the articles
          </Link>
          <a href={`mailto:${siteConfig.contactEmail}`} className="btn">
            Get in touch
          </a>
        </div>

        {tags.length > 0 && (
          <div className="about-topics">
            <span className="label">Writes about</span>
            <div className="about-topic-list">
              {tags.map((tag) => (
                <Link key={tag.slug} href={`/tag/${tag.slug}`}>
                  {tag.name}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {page.content_html && (
        <div
          className="prose about-prose"
          dangerouslySetInnerHTML={{ __html: page.content_html }}
        />
      )}
    </div>
  );
}
