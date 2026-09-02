import Link from "next/link";
import { siteConfig } from "@/lib/site";
import { NavLinks } from "./NavLinks";

/**
 * The primary nav.
 *
 * About is a database-backed page rather than a hardcoded route, so the copy
 * behind it is editable from the admin.
 *
 * The Newsletter and Contact pages still exist and still answer at their URLs
 * — they are simply not linked from here. Deleting them would throw away copy
 * that was written, and a page can be linked again in one line.
 */
const NAV_LINKS = [
  { href: "/articles", label: "Articles" },
  { href: "/about", label: "About" },
] as const;

/**
 * Nav bar: the wordmark on the left, everything else on the right.
 *
 * The wordmark is the site name set in serif, lowercase, as one word — it
 * reads as an identity mark rather than a heading, which is why it does not
 * use the condensed display face the homepage hero does.
 *
 * The author's name used to sit on the right. On a single-author blog it said
 * nothing the About page does not, and it competed with the nav for the one
 * place a reader looks for navigation.
 */
export function SiteNav() {
  return (
    <header className="nav">
      <Link href="/" className="nav-mark">
        {siteConfig.name}
      </Link>

      <nav className="nav-links" aria-label="Primary">
        <NavLinks links={NAV_LINKS} />
        <Link href="/search" className="nav-search" aria-label="Search">
          <SearchIcon />
        </Link>
      </nav>
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
