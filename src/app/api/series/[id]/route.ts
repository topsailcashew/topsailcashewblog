import { getDb } from "@/db/client";
import { handle, json, notFound, readJsonBody } from "@/lib/http";
import { revalidatePublicPages } from "@/lib/revalidate";
import { deleteSeries, getSeriesById, updateSeries } from "@/lib/series";
import { updateSeriesSchema, uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function seriesId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

export const PATCH = handle(async (request: Request, context: RouteContext) => {
  const id = await seriesId(context);
  const body = updateSeriesSchema.parse(await readJsonBody(request));

  const db = getDb();
  const before = await getSeriesById(db, id);
  if (!before) throw notFound("Series");

  const updated = await updateSeries(db, id, body);
  // Both slugs: renaming must not strand the old series URL.
  await revalidatePublicPages(db, { seriesSlugs: [updated.slug, before.slug] });
  return json({ series: updated });
});

export const DELETE = handle(async (_request: Request, context: RouteContext) => {
  const id = await seriesId(context);
  const db = getDb();

  // Read it first: once it is gone we cannot know which URL it occupied.
  const existing = await getSeriesById(db, id);
  await deleteSeries(db, id);

  if (existing) {
    await revalidatePublicPages(db, { seriesSlugs: [existing.slug] });
  }
  return new Response(null, { status: 204 });
});
