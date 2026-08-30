import Link from "next/link";
import { siteConfig } from "@/lib/site";

/**
 * Chrome for every reading page. Server-rendered with no client JavaScript —
 * the public site ships none at all.
 */
export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="site">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      <header className="site-header">
        <div className="wrap">
          <Link href="/" className="site-title">
            {siteConfig.name}
          </Link>
          <nav className="site-nav" aria-label="Primary">
            <a href="/rss.xml">RSS</a>
          </nav>
        </div>
      </header>

      <main className="site-main" id="content">
        {children}
      </main>

      <footer className="site-footer">
        <div className="wrap">
          <span>
            © {new Date().getFullYear()} {siteConfig.name}
          </span>
          <a href="/rss.xml">Subscribe by RSS</a>
        </div>
      </footer>
    </div>
  );
}
