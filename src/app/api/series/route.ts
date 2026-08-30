import { getDb } from "@/db/client";
import { handle, json, readJsonBody } from "@/lib/http";
import { revalidatePublicPages } from "@/lib/revalidate";
import { createSeries, listSeries } from "@/lib/series";
import { createSeriesSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** GET /api/series — every series with its published-post count. */
export const GET = handle(async () => {
  return json({ series: await listSeries(getDb()) });
});

/** POST /api/series — create one. */
export const POST = handle(async (request: Request) => {
  const body = createSeriesSchema.parse(await readJsonBody(request));
  const db = getDb();
  const created = await createSeries(db, body);
  await revalidatePublicPages(db, { seriesSlugs: [created.slug] });
  return json({ series: created }, 201);
});
