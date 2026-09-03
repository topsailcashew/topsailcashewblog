import { getDb } from "@/db/client";
import { AP_CONTENT_TYPE } from "@/lib/activitypub/actor";
import { buildFollowers } from "@/lib/activitypub/activities";
import { countFollowers, listFollowerUris } from "@/lib/activitypub/delivery";
import { loadFediverseSettings } from "@/lib/activitypub/keys";

export const dynamic = "force-dynamic";

/** The followers collection, which clients read to show a count on the profile. */
export async function GET() {
  const db = getDb();
  const settings = await loadFediverseSettings(db).catch(() => null);
  if (!settings?.enabled) return new Response("Not found", { status: 404 });

  const [uris, total] = await Promise.all([listFollowerUris(db), countFollowers(db)]);
  return Response.json(buildFollowers(uris, total), {
    headers: { "content-type": AP_CONTENT_TYPE },
  });
}
