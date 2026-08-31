import { ReadingFooter, SiteNav } from "@/components/public/SiteChrome";

/**
 * Chrome for every public page, homepage included.
 *
 * Design.md §3 called for the homepage to float on a black canvas while
 * reading pages sat on plain white. That framing has been dropped, so there is
 * no longer anything to separate — one layout serves the whole public site.
 */
export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="reading-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
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
