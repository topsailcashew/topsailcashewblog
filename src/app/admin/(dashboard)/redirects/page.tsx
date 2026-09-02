import { RedirectManager } from "@/components/admin/RedirectManager";

export const dynamic = "force-dynamic";

export default function AdminRedirectsPage() {
  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Redirects</h1>
      </div>
      <p className="hint">
        Renaming a post or page records one of these automatically, so links
        that already point at the old address keep working. Add your own for
        URLs that came from somewhere else entirely.
      </p>
      <RedirectManager />
    </main>
  );
}
