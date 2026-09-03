import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { handle, json } from "@/lib/http";
import {
  countSubscribersByStatus,
  getAcquisitionSources,
  getGrowthSeries,
  listSubscribers,
} from "@/lib/subscribers";
import { listSubscribersQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** GET /api/subscribers — the audience list, with the numbers beside it. */
export const GET = handle(async (request: NextRequest) => {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  for (const key of ["status", "q", "limit", "offset"] as const) {
    const value = params.get(key);
    if (value !== null && value !== "") raw[key] = value;
  }
  const query = listSubscribersQuerySchema.parse(raw);
  const db = getDb();

  const [items, counts, growth, sources] = await Promise.all([
    listSubscribers(db, {
      status: query.status,
      search: query.q,
      limit: query.limit,
      offset: query.offset,
    }),
    countSubscribersByStatus(db),
    getGrowthSeries(db, 30),
    getAcquisitionSources(db),
  ]);

  return json({ subscribers: items, counts, growth, sources });
});
