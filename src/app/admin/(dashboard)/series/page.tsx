import { getDb } from "@/db/client";
import { SeriesManager } from "@/components/admin/SeriesManager";
import { listSeries, type SerializedSeries } from "@/lib/series";

export const dynamic = "force-dynamic";

export default async function SeriesAdminPage() {
  let series: SerializedSeries[] = [];
  let error: string | null = null;
  try {
    series = await listSeries(getDb());
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  return (
    <main>
      <h1>Series</h1>
      <p className="muted">
        Group posts that belong together. Order on the public page follows
        publication date.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <SeriesManager series={series} />
      )}
    </main>
  );
}
