import type { Metadata } from "next";
import localFont from "next/font/local";
import { Analytics } from "@/components/public/Analytics";
import { JsonLd } from "@/components/public/JsonLd";
import { siteConfig, siteUrl } from "@/lib/site";
import { websiteJsonLd } from "@/lib/structured-data";
import "./globals.css";

/**
 * Three families, each with one job (Design.md §4), served from our own repo.
 *
 * `next/font/local` rather than `next/font/google`: the Google loader fetches
 * from fonts.googleapis.com at build time, so a build on a machine that cannot
 * reach it fails outright — which is exactly what happened here. The files are
 * vendored in src/fonts, so the build has no network dependency at all.
 *
 * Anton rather than the suggested Archivo Black: §4 asks for "a true
 * condensed-black cut, don't fake condensation via letter-spacing alone", and
 * Archivo Black is a black weight at normal width. Anton is genuinely
 * condensed and was drawn for exactly this masthead use.
 */
const displayFace = localFont({
  src: [{ path: "../fonts/anton-400.woff2", weight: "400", style: "normal" }],
  variable: "--font-display-face",
  display: "swap",
});

/** Nav, metadata, pills — quiet utility text. */
const uiFace = localFont({
  src: [
    { path: "../fonts/inter-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/inter-500.woff2", weight: "500", style: "normal" },
    { path: "../fonts/inter-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-ui-face",
  display: "swap",
});

/** Body copy, carried over from Phase 3 (Design.md §4, §9). */
const bodyFace = localFont({
  src: [
    { path: "../fonts/source-serif-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/source-serif-400-italic.woff2", weight: "400", style: "italic" },
    { path: "../fonts/source-serif-600.woff2", weight: "600", style: "normal" },
    { path: "../fonts/source-serif-700.woff2", weight: "700", style: "normal" },
  ],
  /*
    The bindings are named *Face on purpose: next/font derives the @font-face
    family name from the JS variable, so `const serif` produced a family
    literally called "serif", shadowing the CSS generic keyword.
  */
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: siteConfig.name, template: `%s — ${siteConfig.name}` },
  description: siteConfig.description,
  // Lets every page declare its canonical as a path; Next resolves them
  // against this. Omitted when unset, since a relative canonical is worse
  // than none.
  metadataBase: siteUrl() ? new URL(siteUrl()) : undefined,
  alternates: { types: { "application/rss+xml": "/rss.xml" } },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang={siteConfig.language}
      className={`${displayFace.variable} ${uiFace.variable} ${bodyFace.variable}`}
    >
      {/*
        The site graph goes in the head, which is where a crawler looks first
        and the only place a root layout can put anything. Per-page blocks —
        the article, its breadcrumb — are rendered by the pages themselves and
        land in the body; schema.org, Google and Bing all read JSON-LD from
        either, and Next's Metadata API has no slot for a script tag.
      */}
      <head>
        <JsonLd json={websiteJsonLd()} />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
