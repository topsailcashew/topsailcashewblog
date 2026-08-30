import type { Metadata } from "next";
import { Anton, Inter, Source_Serif_4 } from "next/font/google";
import { siteConfig } from "@/lib/site";
import "./globals.css";

/**
 * Three families, each with one job (Design.md §4).
 *
 * Anton rather than the suggested Archivo Black: §4 asks for "a true
 * condensed-black cut, don't fake condensation via letter-spacing alone", and
 * Archivo Black is a black weight at normal width. Anton is genuinely
 * condensed and was drawn for exactly this masthead use.
 */
const display = Anton({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: "400", // Anton ships a single weight, which renders as black.
});

/** Nav, metadata, pills — quiet utility text. */
const ui = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-ui",
  weight: ["400", "500", "600"],
});

/** Body copy, carried over from Phase 3 (Design.md §4, §9). */
const serif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: { default: siteConfig.name, template: `%s — ${siteConfig.name}` },
  description: siteConfig.description,
  alternates: { types: { "application/rss+xml": "/rss.xml" } },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang={siteConfig.language}
      className={`${display.variable} ${ui.variable} ${serif.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
