import { getDb } from "@/db/client";
import { handle, json } from "@/lib/http";
import { getCampaignMetrics, getRollingAverage } from "@/lib/newsletter";

export const dynamic = "force-dynamic";

/** GET /api/newsletter — every campaign, with its rates and the baseline. */
export const GET = handle(async () => {
  const db = getDb();
  const [campaigns, rolling] = await Promise.all([
    getCampaignMetrics(db, 30),
    getRollingAverage(db, 10),
  ]);
  return json({ campaigns, rolling });
});
