import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { JsonLd } from "@/components/public/JsonLd";
import { getPublishedPage } from "@/lib/pages";
import { listProminentTags } from "@/lib/public-posts";
import { pageJsonLd } from "@/lib/structured-data";
import { siteConfig, siteUrl } from "@/lib/site";

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
    /*
      An `h-card` — the microformat for a person.

      The JSON-LD elsewhere already says who wrote this site, but the two are
      read by different things: JSON-LD by search engines, h-card by feed
      readers, IndieWeb tooling and anything that parses a page rather than
      querying an API. Both point at the same values, so neither can be the
      one that goes stale.

      The visible heading is a greeting, not a name — "Nate!" is the nickname
      and the legal-ish name is carried alongside it, because a parser asked
      for the author of this site should get the name the posts are bylined
      with, not the word in the poster.
    */
    <div className="shell-wrap about h-card">
      <JsonLd json={pageJsonLd(page)} />

      <span className="p-name" hidden>
        {siteConfig.author}
      </span>
      <a className="u-url" href={siteUrl() || "/"} hidden rel="me">
        {siteConfig.name}
      </a>

      <header className={page.cover_image_url ? "about-hero" : "about-hero about-hero--bare"}>
        {/*
          Two lines, the second stroked rather than filled. The words are one
          sentence, so they are one heading with a line break in it — not two
          headings, which is what it would look like to a screen reader.
        */}
        <h1 className="about-statement">
          <span className="about-line">Hi, I&rsquo;m</span>
          <span className="about-line about-line--outline p-nickname">Nate!</span>
        </h1>

        {page.cover_image_url && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="about-portrait u-photo"
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
          <a href={`mailto:${siteConfig.contactEmail}`} className="btn u-email">
            Get in touch
          </a>
        </div>

        {tags.length > 0 && (
          <div className="about-topics">
            <span className="label">Writes about</span>
            <div className="about-topic-list">
              {tags.map((tag) => (
                <Link key={tag.slug} href={`/tag/${tag.slug}`} className="p-category">
                  {tag.name}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {page.content_html && (
        <div
          className="prose about-prose p-note"
          dangerouslySetInnerHTML={{ __html: page.content_html }}
        />
      )}
    </div>
  );
}
