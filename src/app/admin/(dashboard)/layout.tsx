import Link from "next/link";
import { LogoutButton } from "@/components/admin/LogoutButton";

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
        <Link href="/admin" className="admin-brand">
          Posts
        </Link>
        <div className="row">
          <Link href="/admin/comments">Comments</Link>
          <Link href="/admin/series">Series</Link>
          <Link href="/admin/posts/new">New post</Link>
          <LogoutButton />
        </div>
      </nav>
      {children}
    </div>
  );
}
