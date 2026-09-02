import { MediaLibrary } from "@/components/admin/MediaLibrary";

export const dynamic = "force-dynamic";

/**
 * Everything uploaded, browsable.
 *
 * Rendered client-side rather than server-fetched: the screen is a search box
 * over a grid, so the first paint would be thrown away by the first keystroke.
 */
export default function AdminMediaPage() {
  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Media</h1>
      </div>
      <MediaLibrary />
    </main>
  );
}
