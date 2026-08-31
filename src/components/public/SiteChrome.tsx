import Link from "next/link";
import { siteConfig } from "@/lib/site";

/**
 * The primary nav.
 *
 * About, Newsletter and Contact are database-backed pages rather than
 * hardcoded routes, so the copy behind them is editable from the admin. They
 * are linked unconditionally: a link that appears only once its page exists
 * would make the nav shift shape depending on the data, which is worse than a
 * page the author has yet to fill in.
 */
const NAV_LINKS = [
  { href: "/about", label: "About" },
  { href: "/articles", label: "Articles" },
  { href: "/newsletter", label: "Newsletter" },
  { href: "/contact", label: "Contact" },
] as const;

/**
 * Nav bar, matching the reference screenshots.
 *
 * The wordmark is the site name set in serif, lowercase, as one word — it
 * reads as an identity mark rather than a heading, which is why it does not
 * use the condensed display face the homepage hero does.
 */
export function SiteNav() {
  return (
    <header className="nav">
      <div className="nav-left">
        <Link href="/" className="nav-mark">
          {siteConfig.name}
        </Link>
        <nav className="nav-links" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
          <Link href="/search" className="nav-search" aria-label="Search">
            <SearchIcon />
          </Link>
        </nav>
      </div>

      <div className="nav-author">
        <span className="nav-author-name">{siteConfig.author}</span>
        <span className="nav-author-role">{siteConfig.authorRole}</span>
      </div>
    </header>
  );
}

/** Footer for reading and admin pages. */
export function ReadingFooter() {
  return (
    <footer className="site-footer-plain">
      <span className="footer-mark">{siteConfig.name}</span>
      <nav className="footer-links" aria-label="Footer">
        {NAV_LINKS.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
        <a href="/rss.xml">RSS</a>
      </nav>
      <span className="footer-credit">
        © {new Date().getFullYear()} {siteConfig.author}
      </span>
    </footer>
  );
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" strokeLinecap="round" />
    </svg>
  );
}
