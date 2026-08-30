import { ReadingFooter, SiteNav } from "@/components/public/SiteChrome";

/**
 * Post, tag, series and search pages: standard white background, no black
 * canvas (Design.md §3 — "the framing device is a homepage signature, not a
 * site-wide shell — keeps reading pages from feeling gimmicky over long-form
 * text").
 */
export default function ReadingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="reading-shell">
      <div className="shell-wrap">
        <SiteNav />
      </div>
      <main id="content">{children}</main>
      <div className="shell-wrap">
        <ReadingFooter />
      </div>
    </div>
  );
}
