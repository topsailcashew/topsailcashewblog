import Link from "next/link";
import { LogoutButton } from "@/components/admin/LogoutButton";
import { siteConfig } from "@/lib/site";

/**
 * Chrome for the signed-in admin area. `/admin/login` sits outside this route
 * group so it does not render a nav bar with a logout button to someone who is
 * not signed in.
 */
export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <div className="nav-left">
          <Link href="/admin" className="nav-mark">
            {siteConfig.name}
          </Link>
          <span className="nav-links">
            <Link href="/admin">Home</Link>
            <Link href="/admin/articles">Articles</Link>
            <Link href="/admin/posts/new">New Post</Link>
            <Link href="/admin/comments">Comments</Link>
            <Link href="/admin/series">Series</Link>
            <Link href="/admin/pages">Pages</Link>
          </span>
        </div>
        <div className="nav-author">
          <span className="nav-author-name">{siteConfig.author}</span>
          <span className="nav-author-role">{siteConfig.authorRole}</span>
          <LogoutButton />
        </div>
      </nav>
      {children}
    </div>
  );
}
