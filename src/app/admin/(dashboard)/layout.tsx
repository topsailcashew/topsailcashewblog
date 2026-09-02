import Link from "next/link";
import { LogoutButton } from "@/components/admin/LogoutButton";
import { siteConfig } from "@/lib/site";

/**
 * Chrome for the signed-in admin area. `/admin/login` sits outside this route
 * group so it does not render a nav bar with a logout button to someone who is
 * not signed in.
 */

/**
 * Grouped rather than a flat run of eight links.
 *
 * "Write" is what the blog is for and gets the primary action; the rest is
 * upkeep. Flat, they all looked equally important and "New Post" — the one
 * thing done most often — was the third item in an undifferentiated row.
 */
const SECTIONS = [
  { label: "Articles", href: "/admin/articles" },
  { label: "Pages", href: "/admin/pages" },
  { label: "Comments", href: "/admin/comments" },
] as const;

const LIBRARY = [
  { label: "Media", href: "/admin/media" },
  { label: "Series", href: "/admin/series" },
  { label: "Redirects", href: "/admin/redirects" },
  { label: "Import", href: "/admin/import" },
] as const;

export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="Admin">
        <div className="admin-nav-left">
          <Link href="/admin" className="nav-mark">
            {siteConfig.name}
          </Link>

          <span className="admin-nav-links">
            {SECTIONS.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
            <span className="admin-nav-divider" aria-hidden="true" />
            {LIBRARY.map((item) => (
              <Link key={item.href} href={item.href} className="admin-nav-minor">
                {item.label}
              </Link>
            ))}
          </span>
        </div>

        <div className="admin-nav-right">
          {/* The site itself, which the admin nav otherwise gives no way back to. */}
          <Link href="/" className="admin-nav-minor" target="_blank" rel="noopener">
            View site ↗
          </Link>
          <Link href="/admin/posts/new" className="btn btn--primary btn--small">
            Write
          </Link>
          <LogoutButton />
        </div>
      </nav>
      {children}
    </div>
  );
}
