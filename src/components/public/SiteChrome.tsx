import Link from "next/link";
import { siteConfig } from "@/lib/site";

/** Nav: wordmark left at UI scale, quiet links and an RSS icon right (§5). */
export function SiteNav() {
  return (
    <header className="nav">
      <Link href="/" className="nav-mark">
        {siteConfig.name}
      </Link>
      <nav className="nav-links" aria-label="Primary">
        <Link href="/search">Search</Link>
        <a href="/rss.xml" className="nav-rss" aria-label="RSS feed">
          <RssIcon />
        </a>
      </nav>
    </header>
  );
}

/** Credit line under the framed page (§5 footer). */
export function CanvasCredit() {
  return (
    <p className="canvas-credit">
      {siteConfig.name} — {siteConfig.description}
    </p>
  );
}

/** Footer for reading pages, which have no black frame to sit under. */
export function ReadingFooter() {
  return (
    <footer className="site-footer-plain">
      <span>
        © {new Date().getFullYear()} {siteConfig.name}
      </span>
      <a href="/rss.xml">Subscribe by RSS</a>
    </footer>
  );
}

function RssIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="3" cy="13" r="2" />
      <path d="M1 6.5A8.5 8.5 0 0 1 9.5 15h2.6A11.1 11.1 0 0 0 1 3.9z" />
      <path d="M1 1v2.6A11.4 11.4 0 0 1 12.4 15H15A14 14 0 0 0 1 1z" />
    </svg>
  );
}
