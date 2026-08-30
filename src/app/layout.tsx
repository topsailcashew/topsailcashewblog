import type { Metadata } from "next";
import { Source_Serif_4 } from "next/font/google";
import { siteConfig } from "@/lib/site";
import "./globals.css";

/**
 * One webfont, for body text only.
 *
 * Source Serif 4 was drawn for reading on screens, and `next/font` self-hosts
 * it from our own origin at build time — no request to Google, no layout
 * shift beyond the `swap`. UI chrome stays on the system sans stack so nav and
 * dates paint immediately and contrast with the serif body.
 */
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
    <html lang={siteConfig.language} className={serif.variable}>
      <body>{children}</body>
    </html>
  );
}
