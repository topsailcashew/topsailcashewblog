import Link from "next/link";
import { siteConfig } from "@/lib/site";
import { NavLinks } from "./NavLinks";

/**
 * The primary nav.
 *
 * About is a database-backed page rather than a hardcoded route, so the copy
 * behind it is editable from the admin.
 *
 * The nav stays at two links plus search: this is a blog, and the top of every
 * page is not the place to sell a mailing list. The standing offers live in the
 * footer instead, where a reader who has reached the bottom of something can
 * find them.
 */
const NAV_LINKS = [
  { href: "/articles", label: "Articles" },
  { href: "/about", label: "About" },
  { href: "https://aluna-2-0.vercel.app/", label: "Aluna App" },
] as const;

/**
 * The footer carries more than the nav.
 *
 * Series had no entry point anywhere — `/series` did not exist and a sequence
 * was reachable only from the "Part N of M" line on a post you had already
 * found. Newsletter had none either, which meant a reader who wanted one had
 * no way to discover there was one.
 */
const FOOTER_LINKS = [
  { href: "/articles", label: "Articles" },
  { href: "/series", label: "Series" },
  { href: "/about", label: "About" },
  { href: "/newsletter", label: "Newsletter" },
  // `/contact` is published and in the sitemap, so search engines could reach
  // it while no reader could: nothing on the site linked to it.
  { href: "/contact", label: "Contact" },
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
        {FOOTER_LINKS.map((link) => (
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
