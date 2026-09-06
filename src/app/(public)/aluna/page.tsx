import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { JsonLd } from "@/components/public/JsonLd";
import { getPublishedPage } from "@/lib/pages";
import { pageJsonLd } from "@/lib/structured-data";

/**
 * What Aluna is, for someone who has not signed up.
 *
 * A dedicated route rather than the database-backed `/[slug]` one, because it
 * has an arrangement of its own — the figure row, the two call-to-action
 * buttons and the safety notice. The page row underneath supplies all of the
 * prose, so the copy is edited in the admin like any other page. `/about` is
 * the same arrangement for the same reason.
 *
 * What is *not* editable is deliberate. The figures are three numbers taken
 * from the app's README, and the safety notice is a statement whose presence
 * should not depend on nobody having deleted a paragraph. Both live in code.
 *
 * ISR, and that is load-bearing: a `force-dynamic` page is not prerendered, so
 * `/[slug]` would claim `/aluna` for the page row and every request would 500.
 * `aluna` is in FILE_ROUTE_SLUGS so that route does not prerender it at all.
 */
export const revalidate = 300;

const SLUG = "aluna";
const APP_URL = "https://aluna-2-0.vercel.app/";

const FALLBACK_DESCRIPTION =
  "A private daily check-in for your body, your emotions and your mind. Eighty-two feelings, twenty-nine places to feel them, and encryption that means nobody else can read any of it.";

/** Numbers, not adjectives. Taken from the app's README. */
const FIGURES = [
  { n: "82", of: "specific emotions", sub: "in seven families" },
  { n: "29", of: "places on the body", sub: "each with its own intensity" },
  { n: "4", of: "breathing patterns", sub: "sound made in the browser" },
] as const;

export async function generateMetadata(): Promise<Metadata> {
  const page = await getPublishedPage(getDb(), SLUG);
  if (!page) return { title: "Aluna" };
  return {
    title: page.title,
    description: FALLBACK_DESCRIPTION,
    alternates: { canonical: `/${SLUG}` },
    openGraph: {
      title: `${page.title} — notice, name, and track how you feel`,
      description: FALLBACK_DESCRIPTION,
      url: `/${SLUG}`,
      type: "website",
    },
  };
}

export default async function AlunaPage() {
  const page = await getPublishedPage(getDb(), SLUG);

  // Unpublishing the page takes the route with it, rather than leaving the
  // buttons and the figures standing over nothing.
  if (!page) notFound();

  return (
    /* No `id="content"` — the layout's <main> carries it, and a skip link
       needs exactly one target. */
    <div className="shell-wrap aluna">
      <JsonLd json={pageJsonLd(page)} />

      <header className="page-head">
        <p className="label">An app I built</p>
        <h1>{page.title}</h1>
        <p>Notice, name, and track how you feel.</p>
      </header>

      <div className="aluna-actions">
        <a
          className="btn btn--primary"
          href={APP_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Aluna
        </a>
        <a
          className="btn"
          href={`${APP_URL}sign-up`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Create an account
        </a>
      </div>

      <ul className="aluna-figures">
        {FIGURES.map((figure) => (
          <li key={figure.of}>
            <span className="aluna-figure-n">{figure.n}</span>
            <span className="aluna-figure-of">{figure.of}</span>
            <span className="aluna-figure-sub">{figure.sub}</span>
          </li>
        ))}
      </ul>

      {page.content_html && (
        <div
          className="prose aluna-prose"
          dangerouslySetInnerHTML={{ __html: page.content_html }}
        />
      )}

      <div className="notice aluna-disclaimer">
        <p>
          Aluna is a notebook for noticing how you feel. It does not diagnose
          anything and is not a substitute for a doctor, a therapist or a crisis
          line. Support numbers are listed under Help in the app.
        </p>
      </div>

      <div className="aluna-foot">
        <a
          className="btn btn--primary"
          href={APP_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Aluna
        </a>
        <a href={`${APP_URL}privacy`} target="_blank" rel="noopener noreferrer">
          Aluna&rsquo;s privacy page
        </a>
        <Link href="/articles">Read the writing instead &rarr;</Link>
      </div>
    </div>
  );
}
